/**
 * The only module in this repository that imports code it did not ship.
 *
 * Isolated for the reason `packages/mcp/src/sdk-connector.ts` is isolated: the
 * one hazardous act is behind one seam, so everything above it is written
 * against `ExtensionLoader` and no test loads a real module by accident. A fake
 * loader is how the host's whole diff-and-activate lifecycle is exercised
 * without a single file on disk.
 *
 * `import()` and not `require`: the entry is ESM by policy —
 * `assertExtensionPolicy` refuses anything that is not `.js` or `.mjs` — and a
 * file URL is what makes an absolute path outside the process's own resolution
 * roots loadable at all.
 *
 * **The cache is the reason a reload is a restart.** Node's module registry
 * keys on the resolved URL and has no eviction, so importing the same path
 * twice returns the same module object however much the file changed. That is
 * not a bug this can route around: a reloaded extension gets a fresh
 * `activate` call on the module Node already holds, and an extension whose
 * *code* changed needs the process restarted. The digest gate makes that
 * visible rather than silent — an edited extension reads `drifted` and stops
 * loading until it is approved again, and the approval is the natural moment to
 * mention the restart.
 */

import { pathToFileURL } from 'node:url';

import { GhostError } from '@ghostwire/core';

import type { Extension } from './extension.js';

/** How a module path becomes an `Extension`. Faked in every test but one. */
export type ExtensionLoader = (entryPath: string) => Promise<Extension>;

/**
 * Imports the entry and takes its `extension` export.
 *
 * Named rather than default, and validated rather than trusted: a module that
 * exports the wrong shape is an extension author's mistake, and the message
 * naming what was expected is the whole of their debugging session.
 */
export const importExtension: ExtensionLoader = async (entryPath) => {
  const module: unknown = await import(pathToFileURL(entryPath).href);
  const candidate = (module as { extension?: unknown }).extension;

  if (!isExtension(candidate)) {
    throw new GhostError(
      'extension',
      `${entryPath} does not export an extension.\n` +
        '  Expected `export const extension = { activate(context) { … } }` — a\n' +
        '  named export called `extension`, with an `activate` function on it.',
      { details: { entryPath } },
    );
  }
  return candidate;
};

function isExtension(value: unknown): value is Extension {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { activate?: unknown }).activate === 'function';
}
