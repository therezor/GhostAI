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
 * **It lives in `@ghostai/core`, not `@ghostai/server`.** `AuthStore` and
 * `NotificationStore` sit in the server on the argument that nothing below the
 * transport raises a notification or a login. That argument is false here:
 * `@ghostai/runtime` builds a jail from an id and `@ghostai/agent` binds a turn
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

import { statSync } from 'node:fs';
import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite';

import { systemClock, type Clock } from './clock.js';
import { GhostError } from './errors.js';
import { ensureDir, workspaceDirFor, type GhostPaths } from './paths.js';
import {
  DEFAULT_WORKSPACE_ID,
  RESERVED_WORKSPACE_IDS,
  deriveSlug,
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

export interface WorkspaceStoreOptions {
  /** Shared with `SessionStore`; see `SessionStore.database`. */
  readonly database: DatabaseSync;
  /** Needed to create a workspace's directory. */
  readonly paths: GhostPaths;
  readonly clock?: Clock;
}

export interface CreateWorkspaceOptions {
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

type Row = Record<string, SQLOutputValue>;

function readString(row: Row, column: string): string {
  const value = row[column];
  return typeof value === 'string' ? value : '';
}

function readInt(row: Row, column: string): number {
  const value = row[column];
  return typeof value === 'number' ? value : 0;
}

function parseMetadata(json: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToWorkspace(row: Row): WorkspaceRecord {
  return {
    id: readString(row, 'id'),
    name: readString(row, 'name'),
    createdAtMs: readInt(row, 'created_at_ms'),
    updatedAtMs: readInt(row, 'updated_at_ms'),
    isDefault: readInt(row, 'is_default') === 1,
    metadata: parseMetadata(readString(row, 'metadata_json')),
  };
}

export class WorkspaceStore {
  readonly #db: DatabaseSync;
  readonly #paths: GhostPaths;
  readonly #clock: Clock;
  readonly #statements = new Map<string, StatementSync>();

  constructor(options: WorkspaceStoreOptions) {
    this.#db = options.database;
    this.#paths = options.paths;
    this.#clock = options.clock ?? systemClock;

    this.#db.exec(SCHEMA);

    // `INSERT OR IGNORE` for the same reason `ensureSession` uses it: two
    // processes opening the same file both end up with one row rather than one
    // of them failing on the primary key.
    const now = this.#clock.now();
    this.#stmt(
      `INSERT OR IGNORE INTO workspaces (id, name, created_at_ms, updated_at_ms, is_default)
       VALUES (?, ?, ?, ?, 1)`,
    ).run(DEFAULT_WORKSPACE_ID, 'Default', now, now);
  }

  #stmt(sql: string): StatementSync {
    const cached = this.#statements.get(sql);
    if (cached !== undefined) return cached;
    const prepared = this.#db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  /** The default first, then by name — the order the switcher renders. */
  list(): WorkspaceRecord[] {
    return this.#stmt(
      'SELECT * FROM workspaces ORDER BY is_default DESC, name COLLATE NOCASE ASC, id ASC',
    )
      .all()
      .map(rowToWorkspace);
  }

  get(id: string): WorkspaceRecord | undefined {
    const row = this.#stmt('SELECT * FROM workspaces WHERE id = ?').get(id);
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

    const id = options.id ?? this.#uniqueSlug(deriveSlug(name));
    if (!isWorkspaceId(id)) {
      throw new GhostError(
        'invalid_input',
        `Not a usable workspace id: ${id}. Use 1-40 lowercase letters, digits and hyphens.`,
        { details: { id } },
      );
    }
    if (RESERVED_WORKSPACE_IDS.has(id)) {
      throw new GhostError('invalid_input', `"${id}" is reserved and cannot name a workspace`, {
        details: { id },
      });
    }
    if (this.get(id) !== undefined) {
      throw new GhostError('conflict', `A workspace called "${id}" already exists`, {
        details: { id },
      });
    }

    const directory = workspaceDirFor(this.#paths, id);
    const existing = statSync(directory, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isDirectory()) {
      throw new GhostError(
        'conflict',
        `"${id}" already exists in the default workspace and is not a folder`,
        { details: { id } },
      );
    }
    ensureDir(directory);

    const now = this.#clock.now();
    this.#stmt(
      `INSERT INTO workspaces (id, name, created_at_ms, updated_at_ms, is_default, metadata_json)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(id, name, now, now, JSON.stringify(options.metadata ?? {}));

    const created = this.get(id);
    if (created === undefined) {
      throw new GhostError('storage', `Workspace ${id} vanished immediately after creation`);
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
      throw new GhostError('not_found', `No workspace called "${id}"`, { details: { id } });
    }
    this.#stmt('UPDATE workspaces SET name = ?, updated_at_ms = ? WHERE id = ?').run(
      trimmed,
      this.#clock.now(),
      id,
    );
    return { ...existing, name: trimmed };
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
      throw new GhostError('not_found', `No workspace called "${id}"`, { details: { id } });
    }
    if (existing.isDefault) {
      throw new GhostError('conflict', 'The default workspace cannot be deleted', {
        details: { id },
      });
    }
    this.#stmt('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  /** `base`, or `base-2`, `base-3`… — the first that is free. */
  #uniqueSlug(base: string): string {
    if (this.get(base) === undefined && !RESERVED_WORKSPACE_IDS.has(base)) return base;
    for (let suffix = 2; ; suffix += 1) {
      // Truncate the stem rather than the suffix, so a long name cannot produce
      // an id that fails the length rule.
      const tail = `-${String(suffix)}`;
      const candidate = `${base.slice(0, 40 - tail.length)}${tail}`;
      if (this.get(candidate) === undefined) return candidate;
    }
  }
}
