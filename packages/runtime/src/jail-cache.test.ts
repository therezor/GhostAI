import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { isGhostError, resolveGhostPaths, type GhostPaths } from '@ghostai/core';
import { WorkspaceJail } from '@ghostai/security';

import { JailCache, MAX_CACHED_JAILS } from './jail-cache.js';

let base: string;
let paths: GhostPaths;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-jail-cache-')));
  paths = resolveGhostPaths({ root: base });
  mkdirSync(paths.workspace, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Counts constructions, so a cache hit is observable rather than inferred. */
function counting(): {
  readonly create: (root: string) => WorkspaceJail;
  readonly roots: string[];
} {
  const roots: string[] = [];
  return {
    create: (root) => {
      roots.push(root);
      return new WorkspaceJail({ root });
    },
    roots,
  };
}

describe('JailCache', () => {
  it('builds the default eagerly, so an unusable workspace fails at construction', () => {
    // `Runtime.#build` computes everything able to fail before it mutates
    // anything. A lazily-built default would move this failure to the first
    // tool call of the next turn, which is the one place it must not be.
    const { create, roots } = counting();
    const cache = new JailCache({ paths, create });

    expect(roots).toEqual([paths.workspace]);
    expect(cache.default.root).toBe(paths.workspace);
  });

  it('throws from the constructor when the workspace root cannot be used', () => {
    const broken = resolveGhostPaths({ root: base, workspace: join(base, 'a-file', 'under') });
    // A file where a directory has to be.
    mkdirSync(join(base, 'x'), { recursive: true });
    writeFileSync(join(base, 'a-file'), 'not a directory');

    try {
      new JailCache({ paths: broken });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('config');
    }
  });

  it('maps the default to the workspace root and a named workspace beneath it', () => {
    const cache = new JailCache({ paths });

    expect(cache.forWorkspace('default').root).toBe(paths.workspace);
    expect(cache.forWorkspace('acme').root).toBe(join(paths.workspace, 'acme'));
  });

  it('creates a named workspace directory on first use', () => {
    const cache = new JailCache({ paths });
    cache.forWorkspace('acme');
    expect(statSync(join(paths.workspace, 'acme')).isDirectory()).toBe(true);
  });

  it('returns the same instance on a hit, rather than re-canonicalising', () => {
    const { create, roots } = counting();
    const cache = new JailCache({ paths, create });

    const first = cache.forWorkspace('acme');
    const second = cache.forWorkspace('acme');

    expect(second).toBe(first);
    expect(roots).toEqual([paths.workspace, join(paths.workspace, 'acme')]);
  });

  it('refuses an id that is not a legal slug, without creating anything', () => {
    const cache = new JailCache({ paths });

    for (const bad of ['../escape', 'a/b', '~', 'Work', '']) {
      expect(isGhostError(catchOf(() => cache.forWorkspace(bad)))).toBe(true);
    }
    // Nothing was created outside the workspace by the attempt.
    expect(statSync(join(base, 'escape'), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('evicts the least recently used once past the bound', () => {
    const { create, roots } = counting();
    const cache = new JailCache({ paths, create, max: 2 });

    // `default` occupies one slot from the constructor onwards.
    const acme = cache.forWorkspace('acme');
    cache.forWorkspace('research');
    const before = roots.length;

    // `acme` is the oldest non-default entry, so it went.
    expect(cache.forWorkspace('acme')).not.toBe(acme);
    expect(roots.length).toBe(before + 1);
  });

  it('never evicts the default, which is held for the life of the cache', () => {
    const cache = new JailCache({ paths, max: 1 });
    const first = cache.default;

    cache.forWorkspace('a');
    cache.forWorkspace('b');
    cache.forWorkspace('c');

    expect(cache.default).toBe(first);
    expect(cache.forWorkspace('default')).toBe(first);
  });

  it('keeps a re-used workspace at the young end of the map', () => {
    const { create, roots } = counting();
    const cache = new JailCache({ paths, create, max: 3 });

    const acme = cache.forWorkspace('acme');
    cache.forWorkspace('research');
    cache.forWorkspace('acme'); // touch, so `research` is now the oldest
    cache.forWorkspace('third');

    expect(cache.forWorkspace('acme')).toBe(acme);
    expect(roots.filter((root) => root.endsWith('acme'))).toHaveLength(1);
  });

  it('defaults its bound to MAX_CACHED_JAILS', () => {
    const { create, roots } = counting();
    const cache = new JailCache({ paths, create });

    // One slot is already the default, built in the constructor.
    for (let index = 0; index < MAX_CACHED_JAILS - 1; index += 1) {
      cache.forWorkspace(`ws-${String(index)}`);
    }
    const built = roots.length;
    // Everything still resident: no eviction happened within the bound.
    cache.forWorkspace('ws-0');
    expect(roots.length).toBe(built);
  });

  it('rebuilds everything after a clear', () => {
    const { create, roots } = counting();
    const cache = new JailCache({ paths, create });
    const acme = cache.forWorkspace('acme');

    cache.clear();

    expect(cache.forWorkspace('acme')).not.toBe(acme);
    expect(roots).toHaveLength(3);
  });

  it('keeps two workspaces disjoint, and neither containing the other', () => {
    const cache = new JailCache({ paths });
    const a = cache.forWorkspace('a');
    const b = cache.forWorkspace('b');

    expect(a.contains(b.root)).toBe(false);
    expect(b.contains(a.root)).toBe(false);
    // The same input resolves to two different files.
    expect(a.resolve('notes.md')).not.toBe(b.resolve('notes.md'));
  });

  it('puts every named workspace inside the default, which is the chosen layout', () => {
    const cache = new JailCache({ paths });
    expect(cache.default.contains(cache.forWorkspace('acme').root)).toBe(true);
  });

  it('cannot address a sibling workspace through a traversal', () => {
    const cache = new JailCache({ paths });
    const a = cache.forWorkspace('a');
    const b = cache.forWorkspace('b');

    // `..` clamps at `a`'s root rather than climbing to the shared parent, so
    // `../b` names a folder *inside* `a` — never the sibling workspace. This is
    // what keeps named workspaces isolated from each other under a layout where
    // they are siblings on disk.
    expect(a.resolve('../b')).toBe(join(a.root, 'b'));
    expect(a.resolve('../b')).not.toBe(b.root);
    expect(b.contains(a.resolve('../b'))).toBe(false);
  });

  it('still refuses a symlink from one workspace into another', () => {
    // Clamping is lexical and cannot see this; the realpath check is what does.
    const cache = new JailCache({ paths });
    const a = cache.forWorkspace('a');
    const b = cache.forWorkspace('b');
    symlinkSync(b.root, join(a.root, 'peek'));

    const verdict = a.check('peek/notes.md');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('outside_root');
  });
});

function catchOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}
