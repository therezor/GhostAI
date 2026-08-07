import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_EXTENSION_FILES,
  assertExtensionPolicy,
  extensionDigest,
  parseExtension,
  readExtensionManifest,
} from '#src/extension.js';

let base: string;

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

/** An install directory holding a manifest and the entry it names. */
function install(
  id: string,
  overrides: Record<string, unknown> = {},
  files: Record<string, string> = { 'dist/index.js': 'export const x = 1;\n' },
): string {
  const dir = join(base, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'ghostai.extension.json'),
    JSON.stringify({ schema: 'ghostai.extension/1', id, ...overrides }),
  );
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(dir, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
  }
  return dir;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-extensions-')));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('parseExtension', () => {
  it('reads a manifest and fills the defaults', () => {
    const manifest = parseExtension(
      encode({ schema: 'ghostai.extension/1', id: 'slack' }),
    );

    expect(manifest.id).toBe('slack');
    expect(manifest.entry).toBe('dist/index.js');
  });

  it('says so when the bytes are not JSON', () => {
    expect(() => parseExtension(new TextEncoder().encode('{'))).toThrow(
      /not valid JSON/,
    );
  });

  it('names the field when the shape is wrong', () => {
    // The issue path is in the message because the operator is looking at a
    // file they wrote by hand, and "is not valid" without a field name sends
    // them to read the whole thing.
    expect(() =>
      parseExtension(encode({ schema: 'ghostai.extension/1' })),
    ).toThrow(/id/);
  });

  it('reports a root-level failure as (root)', () => {
    expect(() => parseExtension(encode('a string'))).toThrow(/\(root\)/);
  });

  it('refuses a schema tag it does not recognise', () => {
    expect(() =>
      parseExtension(encode({ schema: 'ghostai.plugin/1', id: 'slack' })),
    ).toThrow(/not valid/);
  });
});

describe('readExtensionManifest', () => {
  it('reads the manifest an install directory holds', () => {
    const dir = install('slack', { version: '2.0.0' });
    expect(readExtensionManifest(dir).version).toBe('2.0.0');
  });
});

describe('assertExtensionPolicy', () => {
  it('accepts a plain install', () => {
    const dir = install('slack');
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).not.toThrow();
  });

  it('refuses an id that could not name a directory', () => {
    // The id names a directory *and* prefixes every contributed id, so one
    // character class has to hold for both.
    const dir = install('Slack');
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow(/not a usable extension id/);
  });

  it('refuses a manifest whose id disagrees with its directory', () => {
    // Neither side wins. The approval row is keyed by id and the directory is
    // how the extension is found, so a disagreement means the thing approved
    // and the thing registered could differ.
    const dir = install('slack', { id: 'notslack' });
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow(/installed in a directory called "slack"/);
  });

  it('refuses an absolute entry', () => {
    const dir = install('slack', { entry: '/etc/passwd.js' });
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow(/absolute entry/);
  });

  it('refuses an entry that is not an ES module', () => {
    const dir = install(
      'slack',
      { entry: 'dist/index.cjs' },
      {
        'dist/index.cjs': 'module.exports = {};\n',
      },
    );
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow(/not an ES module/);
  });

  it('refuses an entry that escapes the directory lexically', () => {
    writeFileSync(join(base, 'outside.js'), 'export const x = 1;\n');
    const dir = install('slack', { entry: '../outside.js' });
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow(/outside its own directory/);
  });

  it('refuses an entry that escapes through a symlinked directory', () => {
    // The reason the check canonicalises rather than only normalising: `lib`
    // reads as contained and is not. Same order, same reasoning, as the jail.
    const outside = join(base, 'elsewhere');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'index.js'), 'export const x = 1;\n');

    const dir = install('slack', { entry: 'lib/index.js' });
    symlinkSync(outside, join(dir, 'lib'), 'dir');

    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow(/outside its own directory/);
  });

  it('refuses an entry that does not exist', () => {
    // `realpath` is what refuses it, and the message is the ENOENT rather than
    // a sentence — a missing file is not ambiguous.
    const dir = install('slack', { entry: 'dist/missing.js' });
    expect(() => {
      assertExtensionPolicy(readExtensionManifest(dir), dir);
    }).toThrow();
  });
});

describe('extensionDigest', () => {
  it('covers the code, not only the manifest', () => {
    // The whole reason this is not `manifestHash`. A toolbox manifest pins an
    // immutable image; an extension manifest names a path, so hashing it alone
    // would approve a pointer.
    const dir = install('slack');
    const before = extensionDigest(dir);

    writeFileSync(join(dir, 'dist', 'index.js'), 'export const x = 2;\n');

    expect(extensionDigest(dir)).not.toBe(before);
  });

  it('moves when a file is added', () => {
    const dir = install('slack');
    const before = extensionDigest(dir);

    writeFileSync(join(dir, 'dist', 'extra.js'), 'export const y = 1;\n');

    expect(extensionDigest(dir)).not.toBe(before);
  });

  it('moves when a file is renamed but its content is not', () => {
    // The relative path is hashed beside the content precisely for this: a
    // rename changes what `entry` resolves to while no byte of content moved.
    const dir = install('slack');
    const before = extensionDigest(dir);

    rmSync(join(dir, 'dist', 'index.js'));
    writeFileSync(join(dir, 'dist', 'renamed.js'), 'export const x = 1;\n');

    expect(extensionDigest(dir)).not.toBe(before);
  });

  it('is stable across two identical installs', () => {
    // Sorted rather than in `readdir` order, so an install copied between
    // machines keeps its approval instead of losing it to a filesystem.
    const a = install('slack');
    const b = install('slack-two', { id: 'slack-two' });
    rmSync(join(b, 'ghostai.extension.json'));
    writeFileSync(
      join(b, 'ghostai.extension.json'),
      JSON.stringify({ schema: 'ghostai.extension/1', id: 'slack' }),
    );

    expect(extensionDigest(b)).toBe(extensionDigest(a));
  });

  it('refuses a directory with more files than an extension has', () => {
    // The cap is a statement about what an extension is, not a tuning knob: a
    // directory past it is one carrying an unbundled dependency tree, and
    // failing loudly beats a boot that takes ninety seconds for no visible
    // reason.
    const dir = install('slack');
    const many = join(dir, 'many');
    mkdirSync(many, { recursive: true });
    for (let index = 0; index <= MAX_EXTENSION_FILES; index += 1) {
      writeFileSync(join(many, `${String(index)}.txt`), 'x');
    }

    expect(() => extensionDigest(dir)).toThrow(/too large to authorise/);
  });

  it('walks nested directories', () => {
    const dir = install(
      'slack',
      {},
      {
        'dist/index.js': 'export const x = 1;\n',
        'dist/nested/deep/thing.js': 'export const y = 1;\n',
      },
    );
    const before = extensionDigest(dir);

    writeFileSync(
      join(dir, 'dist', 'nested', 'deep', 'thing.js'),
      'export const y = 2;\n',
    );

    expect(extensionDigest(dir)).not.toBe(before);
  });
});
