/**
 * `ghost extension` — list, approve and revoke extensions.
 *
 * The same exception `ghost toolbox` is, for the same reason: approving code
 * to load into the agent's own process is the one operator action that cannot
 * be delegated to the agent, and an install driven from a terminal needs a way
 * to perform it without opening a browser.
 *
 * `approve` is the whole security model in one verb, and here it is one step
 * stronger than the toolbox's. A toolbox manifest pins an immutable image, so
 * hashing the manifest hashes the code; an extension manifest names a *path*,
 * so this records a digest over every byte under the install directory.
 * Editing any file — including the one the manifest points at — moves the
 * digest and revokes the approval, which is why nothing here needs a `--force`.
 *
 * The listing prints what an operator has to weigh before approving, not just
 * the id: what it says it contributes, and where it is loaded from. A review
 * that shows only a name is a rubber stamp with extra steps.
 *
 * It writes only the approval row. Nothing here loads anything — a running
 * `ghost serve` reloads through `POST /api/extensions/:id/approve`, and this
 * command is for the install that is not running yet or is being prepared.
 */

import { DatabaseSync } from 'node:sqlite';

import { GhostError, loadConfig } from '@ghostbot/core';
import { ExtensionStore, type ExtensionResolution } from '@ghostbot/security';

import type { Translations } from './i18n.js';

interface ExtensionOptions {
  readonly action: 'list' | 'approve' | 'revoke';
  readonly id?: string | undefined;
  readonly home?: string | undefined;
  readonly out: (line: string) => void;
  readonly errOut: (line: string) => void;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly t: Translations;
}

/** Everything about an extension that bears on whether it is safe to approve. */
function describe(resolution: ExtensionResolution): readonly string[] {
  const manifest = resolution.manifest;
  if (manifest === undefined) return [];

  const lines = [`    from       ${resolution.dir}`];
  if (manifest.version !== '') lines.push(`    version    ${manifest.version}`);
  if (manifest.description !== '') {
    lines.push(`    about      ${manifest.description}`);
  }
  lines.push(`    entry      ${manifest.entry}`);
  // The line that matters most, so it is never abbreviated away: an extension
  // declaring nothing can still run arbitrary code, and one declaring `tools`
  // is asking for something an operator has to grant per agent afterwards.
  lines.push(
    `    adds       ${manifest.contributes.length === 0 ? 'nothing declared' : manifest.contributes.join(', ')}`,
  );
  return lines;
}

export function runExtension(options: ExtensionOptions): number {
  const { out, errOut } = options;

  const loaded = loadConfig({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const database = new DatabaseSync(loaded.paths.dbFile);
  try {
    const store = new ExtensionStore({
      database,
      dir: loaded.paths.extensionsDir,
    });

    if (options.action === 'list') {
      const ids = store.installedIds();
      if (ids.length === 0) {
        out(`No extensions installed under ${loaded.paths.extensionsDir}`);
        return 0;
      }
      for (const id of ids) {
        const resolution = store.resolve(id);
        out(`${id}  [${label(resolution)}]`);
        for (const line of describe(resolution)) out(line);
        // The whole sentence, not a summary of it. Each of the three refusals
        // already names the command that fixes it.
        if (resolution.problem !== undefined) {
          for (const line of resolution.problem.split('\n')) out(`    ${line}`);
        }
        out('');
      }
      return 0;
    }

    const id = options.id;
    if (id === undefined || id === '') {
      errOut('Which extension? Pass an id — see `ghost extension list`.');
      return 2;
    }

    if (options.action === 'revoke') {
      store.revoke(id);
      out(
        `Revoked ${id}. The files are still installed; it will no longer load.`,
      );
      return 0;
    }

    const approved = store.approve(id);
    out(`Approved ${id}:`);
    for (const line of describe(approved)) out(line);
    out(`    digest     sha256:${approved.digest}`);
    out('');
    out('Editing any file under that directory changes the digest and revokes');
    out('this approval. An extension runs in the server process with the same');
    out('access the server has.');
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

function label(resolution: ExtensionResolution): string {
  return resolution.state === 'approved'
    ? 'approved'
    : resolution.state.toUpperCase();
}
