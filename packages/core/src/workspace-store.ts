/**
 * The workspace registry.
 *
 * A workspace is a named folder the user owns: their files, and — when Phase 3
 * lands — their memories and skills. `default` is the tree at
 * `<root>/workspace` and is also the *parent* of every named workspace, so a
 * turn in `default` reaches all of them and a turn in a named one reaches only
 * itself. That asymmetry is the design, not an oversight: `default` is the
 * broad view, and `WorkspaceJail` keeps named workspaces isolated from each
 * other because `../sibling` resolves outside their own root.
 *
 * **It lives in `@ghostwire/core`, not `@ghostwire/server`.** `AuthStore` and
 * `NotificationStore` sit in the server on the argument that nothing below the
 * transport raises a notification or a login. That argument is false here:
 * `@ghostwire/runtime` builds a jail from an id and `@ghostwire/agent` binds a turn
 * to one, and neither may import the server.
 *
 * **It is a table, not a JSON file.** The registry has a cross-table invariant
 * with `sessions` — a workspace cannot be detached while sessions still name it
 * — and two stores holding that invariant across two storage mechanisms is
 * exactly the shape that produces orphans.
 *
 * **There is no `path` column.** Storing a directory would make "managed
 * directories only" a convention rather than a fact, and the first API that
 * accepted one would hand an authenticated caller the whole filesystem. The
 * directory is derived from the id by `workspaceDirFor`, which also means
 * relocating `GHOSTAI_HOME` moves every workspace with it — the same reasoning
 * that made `agents.defaults.workspace` default to the empty string.
 */

import { renameSync, statSync } from 'node:fs';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import { systemClock, type Clock } from './clock.js';
import { GhostError } from './errors.js';
import {
  ensureDir,
  sharedDirFor,
  workspaceDirFor,
  type GhostPaths,
} from './paths.js';
import { parseMetadata, rowReader, type Row } from './sqlite-row.js';
import {
  DEFAULT_WORKSPACE_ID,
  RESERVED_WORKSPACE_IDS,
  deriveWorkspaceId,
  isWorkspaceId,
} from './workspace-id.js';

export interface WorkspaceRecord {
  /** The slug, and the directory name under the default workspace. */
  readonly id: string;
  readonly name: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  /** True for exactly one row, which cannot be deleted. */
  readonly isDefault: boolean;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface WorkspaceStoreOptions {
  /** Shared with `SessionStore`; see `SessionStore.database`. */
  readonly database: DatabaseSync;
  /** Needed to create a workspace's directory. */
  readonly paths: GhostPaths;
  readonly clock?: Clock;
}

interface CreateWorkspaceOptions {
  readonly name: string;
  /** Derived from the name when absent. */
  readonly id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT    NOT NULL DEFAULT '{}'
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_default ON workspaces(is_default) WHERE is_default = 1;
`;

const read = rowReader('workspaces');

function rowToWorkspace(row: Row): WorkspaceRecord {
  return {
    id: read.string(row, 'id'),
    name: read.string(row, 'name'),
    createdAtMs: read.int(row, 'created_at_ms'),
    updatedAtMs: read.int(row, 'updated_at_ms'),
    isDefault: read.int(row, 'is_default') === 1,
    metadata: parseMetadata(read.string(row, 'metadata_json')),
  };
}

export class WorkspaceStore {
  private readonly db: DatabaseSync;
  private readonly paths: GhostPaths;
  private readonly clock: Clock;
  private readonly statements = new Map<string, StatementSync>();

  constructor(options: WorkspaceStoreOptions) {
    this.db = options.database;
    this.paths = options.paths;
    this.clock = options.clock ?? systemClock;

    this.db.exec(SCHEMA);

    // `INSERT OR IGNORE` for the same reason `ensureSession` uses it: two
    // processes opening the same file both end up with one row rather than one
    // of them failing on the primary key.
    const now = this.clock.now();
    this.stmt(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at_ms, updated_at_ms, is_default)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(DEFAULT_WORKSPACE_ID, 'Default', now, now);
  }

  private stmt(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
  }

  /** The default first, then by name — the order the switcher renders. */
  list(): WorkspaceRecord[] {
    return this.stmt(
      'SELECT * FROM workspaces ORDER BY is_default DESC, name COLLATE NOCASE ASC, id ASC',
    )
      .all()
      .map(rowToWorkspace);
  }

  get(id: string): WorkspaceRecord | undefined {
    const row = this.stmt('SELECT * FROM workspaces WHERE id = ?').get(id);
    return row === undefined ? undefined : rowToWorkspace(row);
  }

  /**
   * Registers a workspace and makes sure its directory exists.
   *
   * Named workspaces are folders *inside* the default tree, so a slug can
   * collide with something the user or the agent already put there. An existing
   * directory is adopted rather than refused — that is what makes "delete keeps
   * the files, recreate with the same name" round-trip — but an existing *file*
   * is a refusal, because the alternative is a workspace whose every operation
   * fails with `ENOTDIR`.
   */
  create(options: CreateWorkspaceOptions): WorkspaceRecord {
    const name = options.name.trim();
    if (name === '') {
      throw new GhostError('invalid_input', 'A workspace needs a name');
    }

    const id = options.id ?? this.uniqueSlug(deriveWorkspaceId(name));
    if (!isWorkspaceId(id)) {
      throw new GhostError(
        'invalid_input',
        `Not a usable workspace id: ${id}. Use 1-40 lowercase letters, digits and hyphens.`,
        { details: { id } },
      );
    }
    if (RESERVED_WORKSPACE_IDS.has(id)) {
      throw new GhostError(
        'invalid_input',
        `"${id}" is reserved and cannot name a workspace`,
        {
          details: { id },
        },
      );
    }
    if (this.get(id) !== undefined) {
      throw new GhostError(
        'conflict',
        `A workspace called "${id}" already exists`,
        {
          details: { id },
        },
      );
    }

    const directory = workspaceDirFor(this.paths, id);
    const existing = statSync(directory, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isDirectory()) {
      throw new GhostError(
        'conflict',
        `"${id}" already exists in the default workspace and is not a folder`,
        { details: { id } },
      );
    }
    ensureDir(directory);

    const now = this.clock.now();
    this.stmt(
      `INSERT INTO workspaces (id, name, created_at_ms, updated_at_ms, is_default, metadata_json)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(id, name, now, now, JSON.stringify(options.metadata ?? {}));

    const created = this.get(id);
    if (created === undefined) {
      throw new GhostError(
        'storage',
        `Workspace ${id} vanished immediately after creation`,
      );
    }
    return created;
  }

  rename(id: string, name: string): WorkspaceRecord {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw new GhostError('invalid_input', 'A workspace needs a name');
    }
    const existing = this.get(id);
    if (existing === undefined) {
      throw new GhostError('not_found', `No workspace called "${id}"`, {
        details: { id },
      });
    }
    this.stmt(
      'UPDATE workspaces SET name = ?, updated_at_ms = ? WHERE id = ?',
    ).run(trimmed, this.clock.now(), id);
    return { ...existing, name: trimmed };
  }

  /**
   * Moves a workspace to a different folder: the row's id, and the tree on disk.
   *
   * The id **is** the directory name, so this is a `rename(2)` and a primary-key
   * update that have to agree. It is one operation rather than two because the
   * two failure modes of doing it separately are both unrecoverable by hand: a
   * row pointing at a folder that is not there, or a folder nothing in the
   * registry can name.
   *
   * **Everything that resolves through the id is the caller's to repoint.**
   * Sessions carry a `workspace_id` and `SessionStore.reassignWorkspace` is how
   * they follow; a cached jail keyed on the old id has to be evicted. Neither is
   * done here, for the reason stated on `delete`: a store reaching into another
   * store's table is how their schemas start to drift.
   *
   * Three things it refuses, each because the alternative is worse than a
   * refusal:
   *
   *  - **The default**, whose directory *is* the workspace root and is also the
   *    parent of every other workspace. There is no rename of it that does not
   *    mean relocating the entire tree, which is `GHOSTAI_HOME`'s job.
   *  - **A folder something already occupies.** `rename(2)` onto an existing
   *    empty directory succeeds on POSIX, which would silently swallow it.
   *  - **A reserved or malformed id**, on the rules that guard every other
   *    place an id becomes a path.
   *
   * What it does *not* protect is a signed URL already in flight: those carry
   * the old folder and stop resolving. They are minted for seconds at a time and
   * the alternative is a folder nobody can correct, so that is the trade.
   */
  relocate(id: string, folder: string): WorkspaceRecord {
    const existing = this.get(id);
    if (existing === undefined) {
      throw new GhostError('not_found', `No workspace called "${id}"`, {
        details: { id },
      });
    }
    if (existing.isDefault) {
      throw new GhostError(
        'conflict',
        'The default workspace is the folder that holds the others and cannot be moved',
        { details: { id } },
      );
    }
    if (folder === id) return existing;

    if (!isWorkspaceId(folder)) {
      throw new GhostError(
        'invalid_input',
        `Not a usable workspace folder: ${folder}. Use 1-40 lowercase letters, digits and hyphens.`,
        { details: { id: folder } },
      );
    }
    if (RESERVED_WORKSPACE_IDS.has(folder)) {
      throw new GhostError(
        'invalid_input',
        `"${folder}" is reserved and cannot name a folder`,
        {
          details: { id: folder },
        },
      );
    }
    if (this.get(folder) !== undefined) {
      throw new GhostError(
        'conflict',
        `A workspace called "${folder}" already exists`,
        {
          details: { id: folder },
        },
      );
    }

    const from = workspaceDirFor(this.paths, id);
    const to = workspaceDirFor(this.paths, folder);
    // Checked rather than left to `rename(2)`, which happily replaces an empty
    // directory at the destination — and the thing it would replace is a folder
    // the user or the agent put there.
    if (statSync(to, { throwIfNoEntry: false }) !== undefined) {
      throw new GhostError(
        'conflict',
        `"${folder}" already exists in the default workspace`,
        {
          details: { id: folder },
        },
      );
    }

    // The directory first. A row updated before a `rename(2)` that then fails —
    // a permission error, a cross-device link — would leave the registry naming
    // a folder that does not exist, and every turn in that workspace creating an
    // empty one beside the real files.
    try {
      renameSync(from, to);
    } catch (error) {
      throw new GhostError(
        'storage',
        `Could not move the workspace folder to "${folder}"`,
        {
          details: { id: folder },
          cause: error,
        },
      );
    }

    // The layer agents working in one folder share is keyed by workspace id too,
    // and lives outside the jail. Nothing writes it yet — it arrives with the
    // memory tools — so this is usually a no-op, and the alternative when it is
    // not is a workspace that silently loses what it had pooled.
    const sharedFrom = sharedDirFor(this.paths, id);
    if (statSync(sharedFrom, { throwIfNoEntry: false }) !== undefined) {
      renameSync(sharedFrom, sharedDirFor(this.paths, folder));
    }

    this.stmt(
      'UPDATE workspaces SET id = ?, updated_at_ms = ? WHERE id = ?',
    ).run(folder, this.clock.now(), id);

    const moved = this.get(folder);
    if (moved === undefined) {
      throw new GhostError(
        'storage',
        `Workspace ${id} vanished while being moved to ${folder}`,
      );
    }
    return moved;
  }

  /**
   * Detaches a workspace: the row goes, the directory stays.
   *
   * Keeping the files is the point. A delete in a web UI is one click away from
   * a misclick, and there is no undo for a recursive remove of a tree the user
   * has been working in — whereas a detached directory can be re-adopted by
   * creating a workspace with the same name.
   *
   * The caller is responsible for the sessions: `SessionStore.countByWorkspace`
   * decides whether to refuse, and `reassignWorkspace` is the way through. Not
   * done here, because the two tables belong to two stores and a store reaching
   * into another's is how their schemas start to drift.
   */
  delete(id: string): void {
    const existing = this.get(id);
    if (existing === undefined) {
      throw new GhostError('not_found', `No workspace called "${id}"`, {
        details: { id },
      });
    }
    if (existing.isDefault) {
      throw new GhostError(
        'conflict',
        'The default workspace cannot be deleted',
        {
          details: { id },
        },
      );
    }
    this.stmt('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  /** `base`, or `base-2`, `base-3`… — the first that is free. */
  private uniqueSlug(base: string): string {
    if (this.get(base) === undefined && !RESERVED_WORKSPACE_IDS.has(base)) {
      return base;
    }
    for (let suffix = 2; ; suffix += 1) {
      // Truncate the stem rather than the suffix, so a long name cannot produce
      // an id that fails the length rule.
      const tail = `-${String(suffix)}`;
      const candidate = `${base.slice(0, 40 - tail.length)}${tail}`;
      if (this.get(candidate) === undefined) return candidate;
    }
  }
}
