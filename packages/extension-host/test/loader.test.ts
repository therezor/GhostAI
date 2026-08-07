/**
 * The one test in this package that imports a real module from disk.
 *
 * Everything else drives `ExtensionHost` through a fake loader, which is the
 * point of the seam. This covers what a fake cannot: that a file on disk
 * exporting the documented shape loads, and that the three ways of getting it
 * wrong each say what was expected.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importExtension } from '#src/loader.js';

let base: string;
let counter = 0;

/**
 * A unique filename per case.
 *
 * Node's module registry keys on the resolved URL and has no eviction, so two
 * cases writing different contents to one path would see the first one twice.
 * That is the same cache the loader's header calls out as the reason a reloaded
 * extension needs a restart, met here rather than described.
 */
function writeModule(source: string): string {
  counter += 1;
  const path = join(base, `entry-${String(counter)}.js`);
  writeFileSync(path, source);
  return path;
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ghostai-loader-'));
  mkdirSync(base, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('importExtension', () => {
  it('takes the named export', async () => {
    const path = writeModule(
      'export const extension = { activate() { return undefined; } };\n',
    );

    const extension = await importExtension(path);

    expect(typeof extension.activate).toBe('function');
  });

  it('refuses a module exporting nothing by that name', async () => {
    const path = writeModule('export const other = { activate() {} };\n');

    await expect(importExtension(path)).rejects.toThrow(
      /does not export an extension/,
    );
  });

  it('refuses a default export, and says what was expected', async () => {
    // `import-x/no-default-export` is on across this repository, so a default
    // is the one shape the in-tree example could not itself use.
    const path = writeModule('export default { activate() {} };\n');

    await expect(importExtension(path)).rejects.toThrow(
      /named export called `extension`/,
    );
  });

  it('refuses an export with no activate on it', async () => {
    const path = writeModule('export const extension = { deactivate() {} };\n');

    await expect(importExtension(path)).rejects.toThrow(
      /does not export an extension/,
    );
  });

  it('refuses a non-object export', async () => {
    const path = writeModule("export const extension = 'nope';\n");

    await expect(importExtension(path)).rejects.toThrow(
      /does not export an extension/,
    );
  });

  it('lets a syntax error through as itself', async () => {
    // Not rewrapped: Node's message names the line and the token, which is more
    // than any sentence this could write.
    const path = writeModule('export const extension = {\n');

    await expect(importExtension(path)).rejects.toThrow();
  });
});
