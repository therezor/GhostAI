/**
 * `ghost toolbox` — list, approve and revoke toolboxes.
 *
 * A fourth command on a surface the roadmap said would stay at three.
 * The exception is deliberate: approving a toolbox is the one operator action
 * that cannot be delegated to the agent, and an install driven from a terminal
 * needs a way to perform it without opening a browser.
 *
 * `approve` is the whole security model in one verb. It records the sha256 of
 * the manifest bytes *as they are now*, and resolution later compares against
 * that — so this is not a flag being set, it is a statement about specific
 * content. Editing the manifest afterwards changes the hash and revokes the
 * approval automatically, which is why nothing here needs a `--force`.
 *
 * The listing prints what an operator has to weigh before approving, not just
 * the id: the image, the network ceiling, the capabilities added back, and any
 * hardening the profile switched off. A review that shows only a name is a
 * rubber stamp with extra steps.
 */

import { GhostError, loadConfig } from '@ghostai/core';
import { ToolboxStore, weakenedIn } from '@ghostai/security';
import type { Toolbox } from '@ghostai/protocol';
import { DatabaseSync } from 'node:sqlite';

import type { Translations } from './i18n.js';

interface ToolboxOptions {
  readonly action: 'list' | 'approve' | 'revoke';
  readonly id?: string | undefined;
  readonly home?: string | undefined;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly t: Translations;
}

/** Everything about a profile that bears on whether it is safe to approve. */
function describe(profile: Toolbox): readonly string[] {
  const lines = [
    `    image      ${profile.image}`,
    `    network    ${profile.network.maxMode}`,
    `    limits     ${String(profile.limits.memoryMb)} MB, ${String(profile.limits.cpus)} cpu`,
  ];
  // Only when non-default: a review that lists every field it did *not* need to
  // worry about is a review nobody reads to the end of.
  if (profile.caps.add.length > 0) {
    lines.push(`    caps       +${profile.caps.add.join(' +')}`);
  }
  for (const warning of weakenedIn(profile)) {
    lines.push(`    ${warning}  <-- review this`);
  }
  return lines;
}

export function runToolbox(options: ToolboxOptions): number {
  const { out, errOut } = options;

  const loaded = loadConfig({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const database = new DatabaseSync(loaded.paths.dbFile);
  try {
    const store = new ToolboxStore({
      database,
      dir: loaded.paths.toolboxesDir,
    });

    if (options.action === 'list') {
      const listing = store.list();
      if (listing.length === 0) {
        out(`No toolboxes installed under ${loaded.paths.toolboxesDir}`);
        return 0;
      }
      for (const entry of listing) {
        const state = entry.approved ? 'approved' : 'NOT APPROVED';
        out(`${entry.name}  [${state}]`);
        if (entry.toolbox !== undefined) {
          for (const line of describe(entry.toolbox)) out(line);
        }
        if (entry.problem !== undefined) out(`    problem    ${entry.problem}`);
        out('');
      }
      return 0;
    }

    const id = options.id;
    if (id === undefined || id === '') {
      errOut('Which toolbox? Pass an id — see `ghost toolbox list`.');
      return 2;
    }

    if (options.action === 'revoke') {
      store.revoke(id);
      out(
        `Revoked ${id}. The manifest is still installed; it will no longer run.`,
      );
      return 0;
    }

    const approved = store.approve(id);
    out(`Approved ${id}:`);
    for (const line of describe(approved.toolbox)) out(line);
    out(`    manifest   sha256:${approved.manifestSha256}`);
    out('');
    out('Editing the manifest changes its hash and revokes this approval.');
    return 0;
  } catch (error) {
    // `GhostError` messages are written to be read by the person who caused
    // them — they already name the file and what to do next.
    errOut(error instanceof GhostError ? error.message : String(error));
    return 1;
  } finally {
    database.close();
  }
}
