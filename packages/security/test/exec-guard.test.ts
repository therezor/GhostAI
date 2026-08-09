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

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGhostError } from '@ghostwire/core';
import { type ExecToolConfig, ExecToolConfigSchema } from '@ghostwire/protocol';

import {
  SHELL_BINARIES,
  binaryName,
  createOutputCap,
  guardExec,
} from '#src/exec-guard.js';
import { WorkspaceJail } from '#src/jail.js';

let base: string;
let root: string;
let jail: WorkspaceJail;

const config = (patch: Partial<ExecToolConfig> = {}): ExecToolConfig =>
  ExecToolConfigSchema.parse(patch);

const kindOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isGhostError(error) ? error.kind : 'not-a-ghost-error';
  }
  return 'did-not-throw';
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-exec-')));
  root = join(base, 'workspace');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'script.js'), '');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(base, 'outside.txt'), 'secret');
  jail = new WorkspaceJail({ root });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('binaryName', () => {
  it.each([
    ['git', 'git'],
    ['/usr/bin/git', 'git'],
    ['./tools/git', 'git'],
    ['git.exe', 'git'],
    ['GIT.EXE', 'GIT'],
    ['C:\\Program Files\\Git\\git.exe', 'git'],
    ['node.cmd', 'node'],
    ['script.js', 'script.js'],
  ])('reduces %j to %j', (input, expected) => {
    expect(binaryName(input)).toBe(expected);
  });
});

describe('guardExec: the plan', () => {
  it('returns argv unchanged, rooted at the workspace', () => {
    const plan = guardExec(['node', 'script.js', '--flag'], { jail });
    expect(plan.file).toBe('node');
    expect(plan.args).toEqual(['script.js', '--flag']);
    expect(plan.cwd).toBe(root);
  });

  it('does not rewrite a path argument to an absolute path', () => {
    // The child's cwd is the workspace, and rewriting would corrupt any argument
    // that only looked like a path.
    const plan = guardExec(['git', 'log', 'src/a.ts'], { jail });
    expect(plan.args).toEqual(['log', 'src/a.ts']);
  });

  it('resolves a program given as a workspace-relative path', () => {
    writeFileSync(join(root, 'build.sh'), '');
    const plan = guardExec(['./build.sh'], { jail });
    expect(plan.file).toBe(join(root, 'build.sh'));
  });

  it('leaves an absolute system binary alone', () => {
    const plan = guardExec(['/usr/bin/git', 'status'], { jail });
    expect(plan.file).toBe('/usr/bin/git');
    expect(plan.paths).toEqual([]);
  });

  it('carries the configured caps into the plan', () => {
    const plan = guardExec(['git'], {
      jail,
      config: config({ timeoutMs: 5000, maxOutputBytes: 4096 }),
    });
    expect(plan.timeoutMs).toBe(5000);
    expect(plan.maxOutputBytes).toBe(4096);
  });
});

describe('guardExec: the environment', () => {
  it('passes only allow-listed variables', () => {
    const plan = guardExec(['git'], {
      jail,
      env: {
        PATH: '/usr/bin',
        HOME: '/home/x',
        AWS_SECRET_ACCESS_KEY: 'leak',
        LANG: 'en_US',
      },
    });
    expect(plan.env).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/x',
      LANG: 'en_US',
    });
  });

  it('omits an allow-listed variable that is not set', () => {
    const plan = guardExec(['git'], { jail, env: { PATH: '/usr/bin' } });
    expect(Object.keys(plan.env)).toEqual(['PATH']);
  });

  it('honours a narrowed allow-list', () => {
    const plan = guardExec(['git'], {
      jail,
      config: config({ envAllowlist: ['LANG'] }),
      env: { PATH: '/usr/bin', LANG: 'C' },
    });
    expect(plan.env).toEqual({ LANG: 'C' });
  });

  it('appends to PATH', () => {
    const plan = guardExec(['git'], {
      jail,
      config: config({ pathAppend: '/opt/tools/bin' }),
      env: { PATH: '/usr/bin' },
    });
    expect(plan.env.PATH).toBe('/usr/bin:/opt/tools/bin');
  });

  it('uses pathAppend as PATH when the environment has none', () => {
    const plan = guardExec(['git'], {
      jail,
      config: config({ pathAppend: '/opt/tools/bin' }),
      env: {},
    });
    expect(plan.env.PATH).toBe('/opt/tools/bin');
  });

  it('defaults to the process environment', () => {
    const plan = guardExec(['git'], { jail });
    expect(plan.env.PATH).toBe(process.env.PATH);
  });
});

describe('guardExec: refusals', () => {
  it('refuses when exec is disabled', () => {
    expect(
      kindOf(() =>
        guardExec(['git'], { jail, config: config({ enable: false }) }),
      ),
    ).toBe('permission_denied');
  });

  it.each([[[]], [['']]])('refuses the empty argv %j', (argv) => {
    expect(kindOf(() => guardExec(argv, { jail }))).toBe('invalid_input');
  });

  it('refuses a NUL byte anywhere in argv', () => {
    expect(kindOf(() => guardExec(['git', 'log\0--all'], { jail }))).toBe(
      'permission_denied',
    );
    expect(kindOf(() => guardExec(['git\0', 'log'], { jail }))).toBe(
      'permission_denied',
    );
  });

  it('refuses a denied binary, by basename', () => {
    const denied = config({ deniedBinaries: ['curl'] });
    expect(
      kindOf(() => guardExec(['curl', 'https://x'], { jail, config: denied })),
    ).toBe('permission_denied');
    expect(
      kindOf(() => guardExec(['/usr/bin/curl'], { jail, config: denied })),
    ).toBe('permission_denied');
    expect(
      kindOf(() => guardExec(['curl.exe'], { jail, config: denied })),
    ).toBe('permission_denied');
  });

  it('refuses anything outside a non-empty allow-list', () => {
    const only = config({ allowedBinaries: ['git', 'node'] });
    expect(guardExec(['git', 'status'], { jail, config: only }).file).toBe(
      'git',
    );
    expect(
      kindOf(() => guardExec(['rm', '-rf', 'src'], { jail, config: only })),
    ).toBe('permission_denied');
  });

  it('lets the deny-list win over the allow-list', () => {
    const both = config({ allowedBinaries: ['git'], deniedBinaries: ['git'] });
    expect(kindOf(() => guardExec(['git'], { jail, config: both }))).toBe(
      'permission_denied',
    );
  });

  it.each(SHELL_BINARIES)('refuses the shell %s by default', (shell) => {
    expect(kindOf(() => guardExec([shell, 'script.js'], { jail }))).toBe(
      'permission_denied',
    );
  });

  it('allows a shell that was explicitly allow-listed', () => {
    const plan = guardExec(['bash', 'script.js'], {
      jail,
      config: config({ allowedBinaries: ['bash'] }),
    });
    expect(plan.file).toBe('bash');
  });

  it.each(['-c', '-lc', '--command', '/C', '-Command', '-EncodedCommand'])(
    'refuses %s even for an allow-listed shell',
    (flag) => {
      // This is the one thing a metacharacter deny-list was ever aiming at: a
      // program string handed to a shell re-creates the parsing argv removes.
      const allowed = config({ allowedBinaries: ['bash', 'powershell'] });
      expect(
        kindOf(() =>
          guardExec(['bash', flag, 'rm -rf / | sh'], { jail, config: allowed }),
        ),
      ).toBe('permission_denied');
    },
  );

  it('does not scan arguments for shell metacharacters', () => {
    // These are inert under execFile with shell: false, and rejecting them would
    // break legitimate commands while blocking nothing.
    const plan = guardExec(
      ['git', 'commit', '-m', 'fix $(HOME) && `date` | sh'],
      { jail },
    );
    expect(plan.args).toContain('fix $(HOME) && `date` | sh');
  });
});

describe('guardExec: path arguments', () => {
  it.each([
    ['a traversal', '../outside.txt'],
    ['a deep traversal', 'src/../../outside.txt'],
    ['an absolute path', '/etc/passwd'],
    ['a home path', '~/.ssh/id_ed25519'],
    ['a UNC path', '\\\\server\\share'],
    ['a drive letter', 'C:\\Windows\\System32'],
    ['a flag value that escapes', '--output=../outside.txt'],
    ['a flag value that is absolute', '--output=/etc/passwd'],
  ])('refuses %s', (name, argument) => {
    expect(kindOf(() => guardExec(['cat', argument], { jail }))).toBe(
      'jail_escape',
    );
  });

  it('refuses a symlink argument that points out of the workspace', () => {
    // The string looks contained; the link resolves to the workspace's parent.
    symlinkSync(base, join(root, 'escape'));
    expect(
      kindOf(() => guardExec(['cat', 'escape/outside.txt'], { jail })),
    ).toBe('jail_escape');
  });

  it.each([
    ['a traversal', '../evil.sh'],
    ['a home path', '~/bin/evil'],
  ])('refuses a program path that is %s', (name, argv0) => {
    expect(kindOf(() => guardExec([argv0], { jail }))).toBe('jail_escape');
  });

  it('treats a drive-letter program path as a system binary, like an absolute one', () => {
    // Symmetry with /usr/bin/git: an absolute program path in either platform's
    // spelling is a system binary, and the allow/deny lists are what rule on it.
    expect(guardExec(['C:\\Program Files\\Git\\git.exe'], { jail }).file).toBe(
      'C:\\Program Files\\Git\\git.exe',
    );
    expect(
      kindOf(() =>
        guardExec(['C:\\Program Files\\Git\\git.exe'], {
          jail,
          config: config({ deniedBinaries: ['git'] }),
        }),
      ),
    ).toBe('permission_denied');
  });

  it('ignores an empty argument', () => {
    expect(guardExec(['git', 'log', '', '--oneline'], { jail }).args).toEqual([
      'log',
      '',
      '--oneline',
    ]);
  });

  it.each([
    ['a bare flag', '--all'],
    ['a short flag', '-m'],
    ['a message with no separator', 'fix the thing'],
    ['a flag with a non-path value', '--format=json'],
    ['an empty flag value', '--output='],
    ['a contained relative path', 'src/index.ts'],
    ['a dot-slash path', './script.js'],
    ['a numeric argument', '42'],
  ])('accepts %s', (name, argument) => {
    expect(guardExec(['git', argument], { jail }).args).toEqual([argument]);
  });

  it('refuses a bare filename that is a symlink out of the workspace', () => {
    // No separator, so a shape-based heuristic would wave it through — and the
    // child would read whatever the link points at.
    symlinkSync(join(base, 'outside.txt'), join(root, 'notes.txt'));
    expect(kindOf(() => guardExec(['cat', 'notes.txt'], { jail }))).toBe(
      'jail_escape',
    );
  });

  it('collects the path-shaped arguments for the audit log', () => {
    writeFileSync(join(root, 'src', 'a.ts'), '');
    const plan = guardExec(
      ['node', 'script.js', 'src/a.ts', '--out=src/b.ts'],
      { jail },
    );
    expect(plan.paths).toEqual([
      join(root, 'src', 'a.ts'),
      join(root, 'src', 'b.ts'),
    ]);
  });

  it('does not report a URL argument as a file it touches', () => {
    const plan = guardExec(['curl', 'https://example.com/a/b'], { jail });
    expect(plan.paths).toEqual([]);
    expect(plan.args).toEqual(['https://example.com/a/b']);
  });

  it('accepts a message too long for the filesystem to answer for', () => {
    // Unverifiable but not path-shaped: refusing a long commit message would be
    // the guard inventing a rule of its own.
    const message = 'x'.repeat(5000);
    expect(
      guardExec(['git', 'commit', '-m', message], { jail }).args,
    ).toContain(message);
  });

  it('still refuses a path-shaped argument too long to verify', () => {
    expect(
      kindOf(() => guardExec(['cat', `src/${'x'.repeat(5000)}`], { jail })),
    ).toBe('jail_escape');
  });

  it('refuses what the jail clamps, which is the one place the two layers differ', () => {
    // The jail is a chroot: `/etc/passwd` addresses a file inside the workspace.
    // The guard cannot follow it there, because the child it is about to spawn
    // resolves that string against the real filesystem.
    expect(jail.check('/etc/passwd').ok).toBe(true);
    expect(kindOf(() => guardExec(['cat', '/etc/passwd'], { jail }))).toBe(
      'jail_escape',
    );
  });
});

/**
 * The acceptance criterion for splitting classification out of resolution.
 *
 * `WorkspaceJail.check` stopped refusing shapes when the workspace became a
 * chroot, so `guardExec` had to grow its own classifier. The risk in that move
 * is silent widening: an argument the old code refused now sailing through to a
 * child process. `refusedBefore` is the pre-chroot syntactic rule written out
 * again from the old source — an independent oracle, not a call into the code
 * under test — and the guard must agree with it on every generated argument.
 */
describe('property: the chroot change did not widen the exec surface', () => {
  const OLD_SEPARATORS = /[\\/]+/;
  const OLD_DRIVE_LETTER = /^[A-Za-z]:/;

  function refusedBefore(input: string): boolean {
    if (input === '') return true;
    if (input.includes('\0')) return true;
    const segments = input.split(OLD_SEPARATORS);
    if (segments[0]?.startsWith('~') === true) return true;
    if (input.startsWith('\\\\') || input.startsWith('//')) return true;
    if (
      input.startsWith('/') ||
      input.startsWith('\\') ||
      OLD_DRIVE_LETTER.test(input)
    ) {
      return true;
    }
    return segments.includes('..');
  }

  /** `pathCandidate`, restated for the same reason `refusedBefore` is. */
  function candidateOf(argument: string): string {
    if (!argument.startsWith('-')) return argument;
    const equals = argument.indexOf('=');
    return equals === -1 ? '' : argument.slice(equals + 1);
  }

  // No NUL and nothing long enough to reach ENAMETOOLONG: those two refusals
  // are about the filesystem and about argv scanning, not about path shape, and
  // the oracle deliberately says nothing about them.
  const fragments = fc.constantFrom(
    '..',
    '../',
    '..\\',
    '/',
    '\\',
    '//',
    '~',
    '~/',
    'C:',
    'c:',
    '.',
    './',
    'src',
    'a.ts',
    'plain',
    '--out=',
    '-m',
  );

  it('accepts an argument exactly when the pre-chroot rule would have', () => {
    fc.assert(
      fc.property(
        fc.array(fragments, { minLength: 1, maxLength: 6 }),
        (parts) => {
          const argument = parts.join('');
          const candidate = candidateOf(argument);
          const expected = candidate !== '' && refusedBefore(candidate);

          let refused = false;
          try {
            guardExec(['git', argument], { jail });
          } catch {
            refused = true;
          }
          expect(refused).toBe(expected);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('holds for a program path as well as for an argument', () => {
    fc.assert(
      fc.property(
        fc.array(fragments, { minLength: 1, maxLength: 4 }),
        (parts) => {
          const argv0 = parts.join('');
          // A bare name goes to PATH and an absolute one is a system binary; only
          // the workspace-relative shape is the jail's business.
          fc.pre(
            argv0 !== '' &&
              !argv0.startsWith('/') &&
              !OLD_DRIVE_LETTER.test(argv0),
          );
          fc.pre(
            argv0.includes('/') ||
              argv0.includes('\\') ||
              argv0.startsWith('~'),
          );

          let refused = false;
          try {
            guardExec([argv0], { jail });
          } catch (error) {
            refused = isGhostError(error) && error.kind === 'jail_escape';
          }
          expect(refused).toBe(refusedBefore(argv0));
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('createOutputCap', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('keeps output that fits', () => {
    const cap = createOutputCap(16);
    expect(cap.push(bytes('hello '))).toBe(true);
    expect(cap.push(bytes('world'))).toBe(true);
    expect(cap.done()).toEqual({
      text: 'hello world',
      truncated: false,
      bytes: 11,
    });
  });

  it('fills exactly to the budget without reporting truncation', () => {
    const cap = createOutputCap(5);
    expect(cap.push(bytes('12345'))).toBe(true);
    expect(cap.done()).toMatchObject({
      text: '12345',
      truncated: false,
      bytes: 5,
    });
  });

  it('truncates mid-chunk and tells the caller to stop', () => {
    const cap = createOutputCap(8);
    expect(cap.push(bytes('12345'))).toBe(true);
    expect(cap.push(bytes('67890'))).toBe(false);
    expect(cap.done()).toEqual({ text: '12345678', truncated: true, bytes: 8 });
  });

  it('refuses everything once the budget is spent', () => {
    const cap = createOutputCap(2);
    expect(cap.push(bytes('ab'))).toBe(true);
    expect(cap.push(bytes('c'))).toBe(false);
    expect(cap.push(bytes('d'))).toBe(false);
    expect(cap.done()).toMatchObject({ text: 'ab', bytes: 2 });
  });

  it('treats 0 as unlimited, matching the config convention', () => {
    const cap = createOutputCap(0);
    for (let index = 0; index < 100; index += 1) {
      expect(cap.push(bytes('x'.repeat(100)))).toBe(true);
    }
    expect(cap.done()).toMatchObject({ truncated: false, bytes: 10_000 });
  });

  it('decodes once at the end, so a codepoint split across chunks survives', () => {
    const emoji = bytes('🐕');
    const cap = createOutputCap(16);
    cap.push(emoji.subarray(0, 2));
    cap.push(emoji.subarray(2));
    expect(cap.done().text).toBe('🐕');
  });

  it('counts bytes rather than characters', () => {
    // Four bytes of budget hold one emoji, not four.
    const cap = createOutputCap(4);
    expect(cap.push(bytes('🐕🐕'))).toBe(false);
    expect(cap.done()).toMatchObject({ text: '🐕', truncated: true, bytes: 4 });
  });
});

describe('property: every path-shaped argument is contained or refused', () => {
  const fragments = fc.constantFrom(
    '..',
    '../',
    '/',
    '\\',
    '~',
    'C:',
    'src',
    'a.ts',
    '.',
    '--out=',
    '-m',
    'plain',
    '\0',
  );

  it('holds for generated argv vectors', () => {
    fc.assert(
      fc.property(
        fc.array(fragments, { minLength: 1, maxLength: 6 }),
        (parts) => {
          const argument = parts.join('');
          let plan;
          try {
            plan = guardExec(['git', argument], { jail });
          } catch {
            return; // refused, which is always an acceptable answer
          }
          // Accepted: then every path it validated is inside the workspace, and the
          // argument reached the child exactly as written.
          for (const path of plan.paths) expect(jail.contains(path)).toBe(true);
          expect(plan.args).toEqual([argument]);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('never accepts an argument containing a traversal segment', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '..'), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.constantFrom('', '--out='),
        (segments, prefix) => {
          fc.pre(segments.includes('..'));
          expect(() =>
            guardExec(['git', `${prefix}${segments.join('/')}`], { jail }),
          ).toThrow();
        },
      ),
    );
  });
});

describe('guardExec: sandboxed', () => {
  const sandboxed = (argv: readonly string[]) =>
    guardExec(argv, { jail, sandboxed: true });

  it('permits a shell, which the container rather than the guard now bounds', () => {
    // On the host a shell puts a parser back between the argv contract and the
    // kernel. In a container that mounts only the workspace it can reach nothing
    // the command could not reach anyway.
    const plan = sandboxed(['bash', '-lc', 'nmap -sV 10.0.0.5 | tee scan.txt']);
    expect(plan.file).toBe('bash');
    expect(plan.args).toEqual(['-lc', 'nmap -sV 10.0.0.5 | tee scan.txt']);
  });

  it('permits an absolute path, which addresses the container and not the host', () => {
    expect(() => sandboxed(['cat', '/etc/os-release'])).not.toThrow();
    expect(() =>
      sandboxed(['nmap', '-oN', '/tmp/scan.txt', '10.0.0.5']),
    ).not.toThrow();
  });

  it('permits a redirect inside a script string', () => {
    // The failure that made lifting the two rules together necessary: the path
    // lives inside the script, so a path check would refuse the very pipelines
    // enabling the shell was meant to allow.
    expect(() =>
      sandboxed(['sh', '-c', 'nuclei -u http://t > /workspace/out.txt']),
    ).not.toThrow();
  });

  it('still enforces the binary deny-list', () => {
    // The container is the boundary; the operator's allow- and deny-lists are
    // still policy and still apply.
    expect(() =>
      guardExec(['curl', 'http://x'], {
        jail,
        sandboxed: true,
        config: { ...config(), deniedBinaries: ['curl'] },
      }),
    ).toThrow(/denied/);
  });

  it('still enforces the binary allow-list', () => {
    expect(() =>
      guardExec(['bash', '-lc', 'x'], {
        jail,
        sandboxed: true,
        config: { ...config(), allowedBinaries: ['nmap'] },
      }),
    ).toThrow(/allow-list/);
  });

  it('still refuses a NUL byte', () => {
    expect(() => sandboxed(['nmap', 'a\0b'])).toThrow(/NUL/);
  });

  it('still refuses to run when exec is disabled entirely', () => {
    expect(() =>
      guardExec(['nmap'], {
        jail,
        sandboxed: true,
        config: { ...config(), enable: false },
      }),
    ).toThrow(/disabled/);
  });

  it('keeps refusing shells and outside paths when not sandboxed', () => {
    // The relaxation is opt-in per call and must not leak into the host path.
    expect(() => guardExec(['bash', '-lc', 'x'], { jail })).toThrow(/shell/);
    expect(() => guardExec(['cat', '/etc/passwd'], { jail })).toThrow(
      /outside/,
    );
  });
});
