/**
 * Which installed extensions an operator has approved, and what is on disk now.
 *
 * The same two halves that deliberately do not trust each other as
 * `ToolboxStore`: the install directory is a set of files, editable by anything
 * with write access, and the approval is a row recording the digest of the
 * exact bytes that were reviewed. Neither is authority alone. Resolution asks
 * whether *these* bytes are approved, so editing an installed extension
 * silently revokes its approval and the next reconcile refuses with a sentence
 * naming the drift. Nobody has to remember to re-approve, because they cannot
 * avoid it.
 *
 * It lives in `@ghostwire/security` for the reason `ToolboxStore` does, and the
 * layer graph makes it non-negotiable: `core` may not import `security`, and
 * the check needs `parseExtension`, `assertExtensionPolicy` and
 * `extensionDigest`. Keeping the table here also keeps the whole "may this code
 * be loaded" decision inside the package that is meant to hold every such
 * decision.
 *
 * Unlike `ToolboxStore.require`, nothing here throws to describe an extension
 * that is not loadable. The host reconciles a whole directory at boot and after
 * every settings save, and one unapproved extension must not take the other
 * four down with it — so a refusal is a `state` on a row, and the sentence
 * explaining it is a field beside it. That is the same infallibility contract
 * `McpManager.reconcile` holds, for the same reason.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

import {
  GhostError,
  isExtensionId,
  systemClock,
  type Clock,
} from '@ghostwire/core';
import type { ExtensionManifest, ExtensionState } from '@ghostwire/protocol';

import {
  assertExtensionPolicy,
  extensionDigest,
  readExtensionManifest,
} from './extension.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS extension_approvals (
  id             TEXT    PRIMARY KEY,
  digest         TEXT    NOT NULL,
  approved_at_ms INTEGER NOT NULL
) STRICT;
`;

/** One installed extension, resolved against its approval. */
export interface ExtensionResolution {
  readonly id: string;
  readonly dir: string;
  /** `unapproved`, `drifted` or `failed` — never `ready`; loading decides that. */
  readonly state: Exclude<ExtensionState, 'ready' | 'disabled'> | 'approved';
  /** Absent when the manifest did not parse or the policy refused it. */
  readonly manifest: ExtensionManifest | undefined;
  /** The digest of what is on disk now. Empty when it could not be computed. */
  readonly digest: string;
  readonly approvedAtMs: number | undefined;
  /** Why it is not `approved`, phrased for the operator. */
  readonly problem: string | undefined;
}

interface ExtensionStoreOptions {
  readonly database: DatabaseSync;
  /** `<root>/extensions`, outside the jail. */
  readonly dir: string;
  readonly clock?: Clock;
}

export class ExtensionStore {
  private readonly db: DatabaseSync;
  private readonly dir: string;
  private readonly clock: Clock;

  constructor(options: ExtensionStoreOptions) {
    this.db = options.database;
    this.dir = options.dir;
    this.clock = options.clock ?? systemClock;
    this.db.exec(SCHEMA);
  }

  private stmt(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  dirFor(id: string): string {
    if (!isExtensionId(id)) {
      throw new GhostError('invalid_input', `Not an extension id: ${id}`, {
        details: { id },
      });
    }
    return join(this.dir, id);
  }

  private approvalFor(
    id: string,
  ): { digest: string; approvedAtMs: number } | undefined {
    const row = this.stmt(
      'SELECT digest, approved_at_ms FROM extension_approvals WHERE id = ?',
    ).get(id) as { digest: string; approved_at_ms: number } | undefined;
    return row === undefined
      ? undefined
      : { digest: row.digest, approvedAtMs: row.approved_at_ms };
  }

  /**
   * What one directory holds, and whether it may run.
   *
   * Answers rather than throws, and the three refusals are three states because
   * each has a different fix: approve it, re-approve it, or repair it. A single
   * "not usable" would put the operator back to reading logs.
   */
  resolve(id: string, dir: string = this.dirFor(id)): ExtensionResolution {
    let manifest: ExtensionManifest;
    try {
      manifest = readExtensionManifest(dir);
      assertExtensionPolicy(manifest, dir);
    } catch (error) {
      return {
        id,
        dir,
        state: 'failed',
        manifest: undefined,
        digest: '',
        approvedAtMs: undefined,
        problem: error instanceof Error ? error.message : String(error),
      };
    }

    let digest: string;
    try {
      digest = extensionDigest(dir);
    } catch (error) {
      return {
        id,
        dir,
        state: 'failed',
        manifest,
        digest: '',
        approvedAtMs: undefined,
        problem: error instanceof Error ? error.message : String(error),
      };
    }

    const approval = this.approvalFor(id);
    if (approval === undefined) {
      return {
        id,
        dir,
        state: 'unapproved',
        manifest,
        digest,
        approvedAtMs: undefined,
        problem:
          `Extension "${id}" is installed but has never been approved.\n` +
          `  Review what it contributes with \`ghostai extension list\`, then\n` +
          `  \`ghostai extension approve ${id}\`.`,
      };
    }
    if (approval.digest !== digest) {
      return {
        id,
        dir,
        state: 'drifted',
        manifest,
        digest,
        approvedAtMs: approval.approvedAtMs,
        problem:
          `Extension "${id}" has changed since it was approved.\n` +
          '  The files on disk no longer match the ones that were reviewed, so it\n' +
          `  will not be loaded. Review the change, then \`ghostai extension approve ${id}\`.`,
      };
    }

    return {
      id,
      dir,
      state: 'approved',
      manifest,
      digest,
      approvedAtMs: approval.approvedAtMs,
      problem: undefined,
    };
  }

  /**
   * Records the digest of what is on disk now. This *is* the approval.
   *
   * Throws where `resolve` answers, and the asymmetry is deliberate: approving
   * is an operator pressing a button about one extension, so a refusal is the
   * answer to their request. Resolving is a sweep over a directory, where one
   * bad row must not end the sweep.
   */
  approve(id: string): ExtensionResolution {
    const dir = this.dirFor(id);
    const manifest = readExtensionManifest(dir);
    assertExtensionPolicy(manifest, dir);
    const digest = extensionDigest(dir);
    const approvedAtMs = this.clock.now();

    this.stmt(
      `INSERT INTO extension_approvals (id, digest, approved_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         digest = excluded.digest,
         approved_at_ms = excluded.approved_at_ms`,
    ).run(id, digest, approvedAtMs);

    return {
      id,
      dir,
      state: 'approved',
      manifest,
      digest,
      approvedAtMs,
      problem: undefined,
    };
  }

  /** Forgets an approval. The files stay on disk; they simply stop loading. */
  revoke(id: string): void {
    this.stmt('DELETE FROM extension_approvals WHERE id = ?').run(id);
  }

  /**
   * Every directory under the extensions root that looks like an install.
   *
   * A directory whose name is not a usable id is skipped silently rather than
   * reported: `.DS_Store`, a `node_modules` someone unpacked, an editor's
   * backup folder. Reporting those as broken extensions would fill the panel
   * with rows nobody can act on. A directory that *is* named like an extension
   * and does not parse is a different thing entirely, and `resolve` reports it.
   */
  installedIds(): readonly string[] {
    let entries: readonly string[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    return entries.filter(isExtensionId).sort();
  }

  /**
   * Resolves an extension from a path in `extensions.load` rather than the
   * install root.
   *
   * The id comes from the manifest, and `assertExtensionPolicy` still requires
   * the directory to be named after it — so an operator cannot point `load` at
   * a checkout and get an extension registering under a name the directory does
   * not say.
   */
  resolvePath(dir: string): ExtensionResolution | undefined {
    try {
      if (!statSync(dir).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    let id: string;
    try {
      id = readExtensionManifest(dir).id;
    } catch (error) {
      return {
        id: dir,
        dir,
        state: 'failed',
        manifest: undefined,
        digest: '',
        approvedAtMs: undefined,
        problem: error instanceof Error ? error.message : String(error),
      };
    }
    return this.resolve(id, dir);
  }
}
