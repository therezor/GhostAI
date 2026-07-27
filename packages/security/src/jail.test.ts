import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGhostError } from '@ghostai/core';

import { WorkspaceJail } from './jail.js';

let base: string;
let root: string;
let outside: string;
let jail: WorkspaceJail;

beforeEach(() => {
  // `realpath` because macOS hands out /var/folders/... which is a symlink to
  // /private/var/folders/... — a jail that compared against the un-canonicalised
  // form would reject every path inside its own workspace.
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-jail-')));
  root = join(base, 'workspace');
  outside = join(base, 'outside');
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'stolen');
  jail = new WorkspaceJail({ root });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('construction', () => {
  it('creates the root when it is missing', () => {
    const created = join(base, 'fresh', 'nested');
    expect(new WorkspaceJail({ root: created }).root).toBe(created);
  });

  it('canonicalises a symlinked root', () => {
    const link = join(base, 'link-to-workspace');
    symlinkSync(root, link);
    expect(new WorkspaceJail({ root: link, create: false }).root).toBe(root);
  });

  it('refuses a missing root when create is off', () => {
    expect(() => new WorkspaceJail({ root: join(base, 'nope'), create: false })).toThrow(
      /Workspace root is unusable/,
    );
  });

  it('reports an unusable root as a config error', () => {
    writeFileSync(join(base, 'a-file'), 'x');
    try {
      new WorkspaceJail({ root: join(base, 'a-file', 'under-a-file') });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('config');
    }
  });
});

describe('resolve', () => {
  it('accepts a plain relative path that does not exist yet', () => {
    expect(jail.resolve('notes.md')).toBe(join(root, 'notes.md'));
  });

  it('accepts a nested path where no segment exists yet', () => {
    expect(jail.resolve('a/b/c/d.txt')).toBe(join(root, 'a', 'b', 'c', 'd.txt'));
  });

  it('accepts an existing file', () => {
    writeFileSync(join(root, 'here.txt'), 'x');
    expect(jail.resolve('here.txt')).toBe(join(root, 'here.txt'));
  });

  it('accepts "." as the workspace itself', () => {
    expect(jail.resolve('.')).toBe(root);
  });

  it('canonicalises through a symlink that stays inside', () => {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'file.txt'), 'x');
    symlinkSync(join(root, 'real'), join(root, 'alias'));
    expect(jail.resolve('alias/file.txt')).toBe(join(root, 'real', 'file.txt'));
  });
});

describe('rejections', () => {
  const cases: readonly {
    readonly name: string;
    readonly input: string;
    readonly rejection: string;
  }[] = [
    { name: 'an empty path', input: '', rejection: 'empty' },
    { name: 'a NUL byte', input: 'notes\0.md', rejection: 'nul_byte' },
    { name: 'a NUL used to truncate an extension', input: 'ok.txt\0.png', rejection: 'nul_byte' },
    { name: 'a bare tilde', input: '~', rejection: 'home_prefix' },
    { name: 'a tilde path', input: '~/.ssh/id_ed25519', rejection: 'home_prefix' },
    { name: 'a tilde with a backslash', input: '~\\.ssh', rejection: 'home_prefix' },
    { name: 'a POSIX absolute path', input: '/etc/passwd', rejection: 'absolute' },
    { name: 'a backslash absolute path', input: '\\Windows\\System32', rejection: 'absolute' },
    { name: 'a drive letter', input: 'C:\\Windows\\System32', rejection: 'absolute' },
    { name: 'a lowercase drive letter', input: 'c:/windows', rejection: 'absolute' },
    { name: 'a UNC path', input: '\\\\server\\share\\file', rejection: 'unc' },
    { name: 'a slash-form UNC path', input: '//server/share/file', rejection: 'unc' },
    { name: 'a traversal', input: '../secret.txt', rejection: 'traversal' },
    { name: 'a deep traversal', input: 'a/b/../../../etc/passwd', rejection: 'traversal' },
    {
      name: 'a traversal that would land back inside',
      input: 'a/../notes.md',
      rejection: 'traversal',
    },
    { name: 'a backslash traversal', input: 'a\\..\\..\\outside', rejection: 'traversal' },
    { name: 'a name too long to verify', input: 'x'.repeat(4096), rejection: 'unverifiable' },
  ];

  for (const { name, input, rejection } of cases) {
    it(`rejects ${name}`, () => {
      const verdict = jail.check(input);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.rejection).toBe(rejection);
    });
  }

  it('rejects a symlink pointing out of the workspace', () => {
    symlinkSync(outside, join(root, 'escape'));
    const verdict = jail.check('escape/secret.txt');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('outside_root');
  });

  it('rejects a symlink to the workspace parent', () => {
    symlinkSync(base, join(root, 'up'));
    expect(jail.check('up/outside/secret.txt').ok).toBe(false);
  });

  it('rejects a path under a symlinked file pointing outside', () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'alias.txt'));
    // The link target exists and resolves outside, so this is an escape rather
    // than a not-yet-created file.
    expect(jail.check('alias.txt').ok).toBe(false);
  });

  it('reports a deleted workspace root as unverifiable rather than allowing the path', () => {
    rmSync(root, { recursive: true, force: true });
    const verdict = jail.check('notes.md');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('unverifiable');
  });

  it('throws jail_escape from resolve, with the rejection in the details', () => {
    try {
      jail.resolve('../secret.txt');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      if (!isGhostError(error)) return;
      expect(error.kind).toBe('jail_escape');
      expect(error.retryable).toBe(false);
      expect(error.details).toMatchObject({ rejection: 'traversal' });
    }
  });

  it('throws invalid_input for an empty path, which is a caller bug and not an attack', () => {
    try {
      jail.resolve('');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('invalid_input');
    }
  });
});

describe('contains', () => {
  it('accepts the root itself and paths under it', () => {
    expect(jail.contains(root)).toBe(true);
    expect(jail.contains(join(root, 'a', 'b'))).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    // The prefix trap: `${root}-evil` passes a naive startsWith check.
    expect(jail.contains(`${root}-evil`)).toBe(false);
  });

  it('rejects the parent and anything else outside', () => {
    expect(jail.contains(base)).toBe(false);
    expect(jail.contains(join(outside, 'secret.txt'))).toBe(false);
  });

  it('handles a root that already ends in a separator', () => {
    // The degenerate case: a jail at the filesystem root. Containment must not
    // compare against `//`.
    const atRoot = new WorkspaceJail({ root: sep, create: false });
    expect(atRoot.contains(join(sep, 'etc'))).toBe(true);
    expect(atRoot.contains(sep)).toBe(true);
  });

  it('folds case only when asked', () => {
    const sensitive = new WorkspaceJail({ root, caseInsensitive: false });
    const insensitive = new WorkspaceJail({ root, caseInsensitive: true });
    const shouted = join(root.toUpperCase(), 'file.txt');
    expect(sensitive.contains(shouted)).toBe(false);
    expect(insensitive.contains(shouted)).toBe(true);
  });
});

describe('relative', () => {
  it('returns the workspace-relative form', () => {
    expect(jail.relative(join(root, 'a', 'b.txt'))).toBe(join('a', 'b.txt'));
  });

  it('throws for a path outside the workspace', () => {
    try {
      jail.relative(join(outside, 'secret.txt'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('jail_escape');
    }
  });
});

describe('property: nothing escapes', () => {
  /**
   * The invariant the whole class exists for: for *any* input, `check` either
   * refuses it or returns a path under the canonical root. Anything else is a
   * vulnerability, so this is asserted against generated input rather than only
   * the bypasses that happened to be thought of.
   */
  const escapeFragments = fc.constantFrom(
    '..',
    '../',
    '..\\',
    '~',
    '~/',
    '/',
    '//',
    '\\\\',
    'C:',
    '\0',
    '.',
    'a',
    '%2e%2e',
    'ﬁle',
    'e\u0301',
    '\u00e9',
    ' ',
    'x'.repeat(300),
  );

  it('holds for adversarial fragment sequences', () => {
    fc.assert(
      fc.property(fc.array(escapeFragments, { minLength: 1, maxLength: 8 }), (fragments) => {
        const verdict = jail.check(fragments.join(''));
        if (!verdict.ok) return;
        expect(verdict.path === root || verdict.path.startsWith(root + sep)).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('holds for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const verdict = jail.check(input);
        if (!verdict.ok) return;
        expect(verdict.path === root || verdict.path.startsWith(root + sep)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('never accepts a path containing a traversal segment', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '..'), { minLength: 1, maxLength: 6 }),
        (segments) => {
          fc.pre(segments.includes('..'));
          expect(jail.check(segments.join('/')).ok).toBe(false);
        },
      ),
    );
  });
});
