import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGhostError } from '@ghostai/core';

import { WorkspaceJail, pathShapes, singleJail } from '#src/jail.js';

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

describe('clamping', () => {
  /**
   * The workspace is a root in the `chroot` sense, so none of these is a
   * refusal any more: each one *addresses* something inside the workspace. What
   * used to be the rejection is now the `rewrites` entry, which exists so a
   * caller can tell the model what happened rather than leaving it to believe
   * it read the host's file.
   */
  const cases: readonly {
    readonly name: string;
    readonly input: string;
    readonly segments: readonly string[];
    readonly rewrites: readonly string[];
  }[] = [
    { name: 'a bare tilde', input: '~', segments: [], rewrites: ['home_prefix'] },
    {
      name: 'a tilde path',
      input: '~/.ssh/id_ed25519',
      segments: ['.ssh', 'id_ed25519'],
      rewrites: ['home_prefix'],
    },
    {
      name: 'a tilde with a backslash',
      input: '~\\.ssh',
      segments: ['.ssh'],
      rewrites: ['home_prefix'],
    },
    {
      name: 'a POSIX absolute path',
      input: '/etc/passwd',
      segments: ['etc', 'passwd'],
      rewrites: ['absolute'],
    },
    {
      name: 'a backslash absolute path',
      input: '\\Windows\\System32',
      segments: ['Windows', 'System32'],
      rewrites: ['absolute'],
    },
    {
      name: 'a drive letter',
      input: 'C:\\Windows\\System32',
      segments: ['Windows', 'System32'],
      rewrites: ['drive'],
    },
    {
      name: 'a lowercase drive letter',
      input: 'c:/windows',
      segments: ['windows'],
      rewrites: ['drive'],
    },
    {
      name: 'a UNC path',
      input: '\\\\server\\share\\file',
      segments: ['server', 'share', 'file'],
      rewrites: ['unc'],
    },
    {
      name: 'a slash-form UNC path',
      input: '//server/share/file',
      segments: ['server', 'share', 'file'],
      rewrites: ['unc'],
    },
    {
      name: 'a traversal',
      input: '../secret.txt',
      segments: ['secret.txt'],
      rewrites: ['traversal'],
    },
    {
      name: 'a deep traversal',
      input: 'a/b/../../../etc/passwd',
      segments: ['etc', 'passwd'],
      rewrites: ['traversal'],
    },
    {
      name: 'a traversal that lands back inside',
      input: 'a/../notes.md',
      segments: ['notes.md'],
      rewrites: ['traversal'],
    },
    {
      name: 'a backslash traversal',
      input: 'a\\..\\..\\outside',
      segments: ['outside'],
      rewrites: ['traversal'],
    },
    {
      name: 'a drive letter with no separator after it',
      input: 'C:Windows',
      segments: ['Windows'],
      rewrites: ['drive'],
    },
    {
      name: 'a root that is only separators',
      input: '///',
      segments: [],
      rewrites: ['unc'],
    },
  ];

  for (const { name, input, segments, rewrites } of cases) {
    it(`clamps ${name} into the workspace`, () => {
      const verdict = jail.check(input);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      expect(verdict.path).toBe(join(root, ...segments));
      expect(verdict.relative).toBe(segments.join(sep));
      expect(verdict.rewrites).toEqual(rewrites);
    });
  }

  it('leaves a plain relative path alone and reports no rewrite', () => {
    const verdict = jail.check('a/b.txt');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.relative).toBe(join('a', 'b.txt'));
    expect(verdict.rewrites).toEqual([]);
  });

  it('keeps a root marker that is not the first segment as a literal name', () => {
    // `a/C:/b` names a directory called `C:`; only a leading segment can carry
    // a root. Same for `~`.
    expect(jail.check('a/~/b').ok).toBe(true);
    expect(jail.resolve('a/~/b')).toBe(join(root, 'a', '~', 'b'));
  });

  it('accept() throws nothing for a clamped path and hands back the rewrite', () => {
    expect(jail.accept('/etc/passwd').rewrites).toEqual(['absolute']);
  });

  it('does not nest the workspace root inside itself', () => {
    // The failure this fixes was silent, which is what made it worth fixing: the
    // absolute root is the one path a model is most likely to produce — it used
    // to be printed in the system prompt — and clamped segment by segment it
    // landed on `<root><root>/notes/x`. `write_file` created that tree without
    // complaint, and `read_file` reported "not found" for a file that existed.
    const verdict = jail.check(join(root, 'notes', 'x.md'));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.path).toBe(join(root, 'notes', 'x.md'));
    expect(verdict.relative).toBe(join('notes', 'x.md'));
    // Still recorded as a rewrite: a caller that clamped a path has to be able
    // to say so, or the model believes it addressed the host's filesystem.
    expect(verdict.rewrites).toEqual(['absolute']);
  });

  it('resolves the bare workspace root to the root', () => {
    const verdict = jail.check(root);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.path).toBe(root);
    expect(verdict.relative).toBe('');
  });

  it('leaves an absolute path that merely resembles the root alone', () => {
    // Only a genuine prefix is removed. A sibling directory whose name starts
    // with the root's is a different place, and clamping it is the correct
    // outcome rather than stripping a prefix that was never there.
    const verdict = jail.check(`${root}-other/notes/x.md`);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.relative).not.toBe(join('notes', 'x.md'));
    expect(verdict.relative).toContain('notes');
  });

  it('is still a fixed point: the relative form resolves to the same file', () => {
    // The property `normalise` documents, and the one this could have broken —
    // the REST layer hands `relative` back to clients that send it again.
    const first = jail.check(join(root, 'a', 'b.txt'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(jail.resolve(first.relative)).toBe(first.path);
  });

  it('re-folds after stripping a root marker, so stripping cannot create a traversal', () => {
    // Found by the idempotence property. `./c:..` folds to the single segment
    // `c:..`; taking the drive prefix off it leaves a bare `..`, which — if the
    // output were trusted at that point — would join to the workspace's parent
    // and leave containment resting entirely on what `realpath` said.
    const verdict = jail.check('./c:..');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.path).toBe(root);
    expect(verdict.relative).toBe('');
  });
});

describe('refusals', () => {
  const cases: readonly {
    readonly name: string;
    readonly input: string;
    readonly rejection: string;
  }[] = [
    { name: 'an empty path', input: '', rejection: 'empty' },
    { name: 'a NUL byte', input: 'notes\0.md', rejection: 'nul_byte' },
    { name: 'a NUL used to truncate an extension', input: 'ok.txt\0.png', rejection: 'nul_byte' },
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

  it('rejects a dangling symlink instead of reading it as a path that does not exist yet', () => {
    // The bug this closes: `realpathSync` answers ENOENT for a broken link just
    // as it does for an absent name, so the boundary walk used to pop the link,
    // re-append its name, and hand back a contained path — which `write_file`
    // then followed straight out of the workspace, creating the target outside.
    symlinkSync(join(base, 'vault.json'), join(root, 'vault'));
    const verdict = jail.check('vault');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('unverifiable');
  });

  it('rejects a path underneath a dangling symlink', () => {
    symlinkSync(join(base, 'gone'), join(root, 'link'));
    expect(jail.check('link/child.txt').ok).toBe(false);
  });

  it('reports a deleted workspace root as unverifiable rather than allowing the path', () => {
    rmSync(root, { recursive: true, force: true });
    const verdict = jail.check('notes.md');
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.rejection).toBe('unverifiable');
  });

  it('throws jail_escape from resolve, with the rejection in the details', () => {
    // A symlink escape, because that is the only thing left that a well-formed
    // path can be refused for.
    symlinkSync(outside, join(root, 'escape'));
    try {
      jail.resolve('escape/secret.txt');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      if (!isGhostError(error)) return;
      expect(error.kind).toBe('jail_escape');
      expect(error.retryable).toBe(false);
      expect(error.details).toMatchObject({ rejection: 'outside_root' });
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

describe('pathShapes', () => {
  it('classifies without resolving, which is what the exec guard needs', () => {
    expect(pathShapes('/etc/passwd')).toEqual(['absolute']);
    expect(pathShapes('~/.ssh/id_ed25519')).toEqual(['home_prefix']);
    expect(pathShapes('//server/share')).toEqual(['unc']);
    expect(pathShapes('C:\\Windows')).toEqual(['drive']);
    expect(pathShapes('../x')).toEqual(['traversal']);
  });

  it('reports a traversal even when it would land back inside', () => {
    // The old syntactic rule refused any `..` segment, and the exec guard still
    // has to, or `git log a/../../etc` reads outside the workspace.
    expect(pathShapes('a/../b')).toEqual(['traversal']);
  });

  it('is empty for a contained relative path, a flag and a URL', () => {
    expect(pathShapes('src/index.ts')).toEqual([]);
    expect(pathShapes('./script.js')).toEqual([]);
    expect(pathShapes('--format=json')).toEqual([]);
    expect(pathShapes('https://example.com/a/b')).toEqual([]);
  });

  it('agrees with what check() reports having rewritten', () => {
    for (const input of ['/etc/passwd', '~/x', '../x', 'a/../b', 'src/a.ts', 'C:\\x']) {
      const verdict = jail.check(input);
      expect(verdict.ok).toBe(true);
      if (verdict.ok) expect(verdict.rewrites).toEqual(pathShapes(input));
    }
  });
});

describe('singleJail', () => {
  it('answers with the same jail for every workspace', () => {
    const resolver = singleJail(jail);
    expect(resolver.default).toBe(jail);
    expect(resolver.forWorkspace('anything')).toBe(jail);
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

  it('clamps every traversal into the workspace instead of refusing it', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '..'), { minLength: 1, maxLength: 6 }),
        (segments) => {
          fc.pre(segments.includes('..'));
          const verdict = jail.check(segments.join('/'));
          expect(verdict.ok).toBe(true);
          if (!verdict.ok) return;
          expect(verdict.path === root || verdict.path.startsWith(root + sep)).toBe(true);
          expect(verdict.rewrites).toContain('traversal');
        },
      ),
    );
  });

  /**
   * Clamping has to be a projection, and that is a correctness requirement
   * rather than an aesthetic one: the REST layer echoes `jail.relative(...)`
   * back to clients, which then send it again. A normalisation that moved on
   * the second pass would walk a path somewhere new on every round trip.
   */
  it('is idempotent: re-checking the clamped form lands in the same place', () => {
    fc.assert(
      fc.property(fc.array(escapeFragments, { minLength: 1, maxLength: 8 }), (fragments) => {
        const first = jail.check(fragments.join(''));
        if (!first.ok) return;
        const again = jail.check(first.relative === '' ? '.' : first.relative);
        expect(again.ok).toBe(true);
        if (again.ok) expect(again.path).toBe(first.path);
      }),
      { numRuns: 2000 },
    );
  });

  it('preserves segments that only look like traversal', () => {
    // An over-eager normaliser eats `..foo`, `.hidden` or a trailing dot.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('..foo', '.hidden', 'a..b', 'x.', 'plain'), {
          minLength: 1,
          maxLength: 5,
        }),
        (segments) => {
          const verdict = jail.check(segments.join('/'));
          expect(verdict.ok).toBe(true);
          if (verdict.ok) expect(verdict.relative).toBe(segments.join(sep));
        },
      ),
    );
  });
});
