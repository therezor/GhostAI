import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhostError } from '@ghostai/core';
import { ToolboxSchema, type Toolbox } from '@ghostai/protocol';
import type { EffectiveNetwork, ExecPlan } from '@ghostai/security';

import {
  TOOLBOX_MOUNT_DIR,
  RUNS_MOUNT_DIR,
  containerCreateArgv,
  containerExecArgv,
  containerIsGone,
  containerKillArgv,
  containerRunDir,
  containerRunner,
  openTranscript,
} from '#src/container-runner.js';
import type { CommandRunner, RunOutcome, RunRequest } from '#src/runner.js';

const DIGEST = 'sha256:'.concat('b'.repeat(64));

function toolboxOf(overrides: Record<string, unknown> = {}): Toolbox {
  return ToolboxSchema.parse({
    schema: 'ghostai.toolbox/1',
    name: 'kali',
    image: `kalilinux/kali-rolling@${DIGEST}`,
    ...overrides,
  });
}

function planOf(overrides: Partial<ExecPlan> = {}): ExecPlan {
  return {
    file: 'nmap',
    args: ['-sV', '10.0.0.5'],
    cwd: '/host/workspace',
    env: { PATH: '/host/bin', LANG: 'en_GB.UTF-8', SECRET: 'nope' },
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    paths: [],
    ...overrides,
  };
}

const NONE: EffectiveNetwork = {
  mode: 'none',
  allow: [],
  dns: [],
  proxyAllowHosts: [],
};

const create = (
  overrides: Record<string, unknown> = {},
  network: EffectiveNetwork = NONE,
) =>
  containerCreateArgv({
    toolbox: toolboxOf(overrides),
    network,
    mount: { hostPath: '/host/workspace', containerPath: '/workspace' },
    containerName: 'ghost-sbx-abc',
  });

describe('containerCreateArgv: hardening', () => {
  it('drops all capabilities and blocks privilege escalation', () => {
    const argv = create();
    expect(argv).toContain('--cap-drop=ALL');
    expect(argv).toContain('--security-opt=no-new-privileges');
    expect(argv).toContain('--read-only');
  });

  it('drops ALL even when the toolbox forgot to say so', () => {
    // The floor lives in code rather than in data: a manifest with an empty drop
    // list would otherwise inherit Docker's defaults and look correct doing it.
    expect(create({ caps: { drop: [], add: [] } })).toContain('--cap-drop=ALL');
    expect(
      create({ caps: { drop: ['ALL'], add: [] } }).filter(
        (f) => f === '--cap-drop=ALL',
      ),
    ).toHaveLength(1);
  });

  it('passes --init, without which signals never reach the command', () => {
    // The entrypoint override defeats the image's own init, leaving the shell as
    // PID 1 with no signal handler — so cancellation would not propagate and
    // exited children would never be reaped.
    expect(create()).toContain('--init');
  });

  it('adds back only the capabilities the toolbox names', () => {
    const argv = create({ caps: { drop: ['ALL'], add: ['NET_RAW'] } });
    expect(argv).toContain('--cap-add=NET_RAW');
    expect(argv.filter((flag) => flag.startsWith('--cap-add='))).toHaveLength(
      1,
    );
  });

  it('applies every resource limit', () => {
    const argv = create({
      limits: { memoryMb: 4096, cpus: 2, pidsMax: 512, shmSizeMb: 1024 },
    });
    expect(argv).toContain('--memory=4096m');
    expect(argv).toContain('--cpus=2');
    expect(argv).toContain('--pids-limit=512');
    expect(argv).toContain('--shm-size=1024m');
  });

  it('omits a limit set to zero rather than passing an unlimited flag', () => {
    const argv = create({
      limits: { memoryMb: 0, cpus: 0, pidsMax: 0, shmSizeMb: 0 },
    });
    expect(argv.some((flag) => flag.startsWith('--memory'))).toBe(false);
    expect(argv.some((flag) => flag.startsWith('--pids-limit'))).toBe(false);
  });

  it('names a runtime only when it is not the default', () => {
    expect(create().some((flag) => flag.startsWith('--runtime'))).toBe(false);
    expect(create({ runtime: 'runsc' })).toContain('--runtime=runsc');
  });

  it('passes unconfined seccomp only when the toolbox asks for it', () => {
    expect(create()).not.toContain('--security-opt=seccomp=unconfined');
    expect(create({ security: { seccomp: 'unconfined' } })).toContain(
      '--security-opt=seccomp=unconfined',
    );
  });

  it('mounts the workspace at the toolbox workdir', () => {
    const argv = create();
    // `--mount`, not `--volume`: a colon is legal in a path, and the
    // colon-delimited form silently reparses `/Notes:2024/ws` into a different
    // mount entirely.
    expect(argv).toContain('--mount');
    expect(argv).toContain('type=bind,src=/host/workspace,dst=/workspace');
    expect(argv).toContain('--workdir');
  });

  it('survives a colon in the workspace path', () => {
    const argv = containerCreateArgv({
      toolbox: toolboxOf(),
      network: NONE,
      mount: {
        hostPath: '/Users/me/Notes:2024/ws',
        containerPath: '/workspace',
      },
      containerName: 'c',
    });
    expect(argv).toContain(
      'type=bind,src=/Users/me/Notes:2024/ws,dst=/workspace',
    );
  });

  it('mounts the approved manifest read-only, outside the workspace', () => {
    // Immutability from the mount table rather than from anyone remembering to
    // check it. Outside the workdir because nesting a file mount inside a bind
    // mount being established is a `runc` refusal, not merely untidy.
    const argv = containerCreateArgv({
      toolbox: toolboxOf(),
      network: NONE,
      mount: { hostPath: '/host/workspace', containerPath: '/workspace' },
      containerName: 'c',
      manifestPath: '/home/ghost/profiles/kali/profile.json',
    });
    expect(argv).toContain(
      'type=bind,src=/home/ghost/profiles/kali,dst=/run/ghost,ro',
    );
    expect(argv.join(' ')).not.toContain('/workspace/.ghost/profile.json');
  });

  it('runs the container as the toolbox user, so artefacts are not root-owned', () => {
    expect(create({ user: '1000:1000' })).toContain('--user=1000:1000');
    expect(create().some((flag) => flag.startsWith('--user'))).toBe(false);
  });

  it('never grants privilege or the daemon socket, for any toolbox', () => {
    // The assertion that matters most is about what can never appear. A toolbox
    // is operator-installed, but it is still data, and this is the line between
    // "a container policy" and "host root".
    fc.assert(
      fc.property(
        fc.record({
          caps: fc.record({
            drop: fc.array(fc.string()),
            add: fc.array(fc.string()),
          }),
          user: fc.string(),
          workdir: fc.string({ minLength: 1 }),
          security: fc.record({
            seccomp: fc.constantFrom('default', 'unconfined'),
            tmpfs: fc.array(fc.string()),
            devices: fc.array(fc.string()),
          }),
        }),
        (overrides) => {
          const argv = create(overrides);
          expect(argv).not.toContain('--privileged');
          expect(argv.join(' ')).not.toContain('docker.sock');
          expect(argv).toContain('--cap-drop=ALL');
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('containerCreateArgv: network', () => {
  it('isolates the network entirely when the mode is none', () => {
    expect(create()).toContain('--network=none');
  });

  it('joins the gateway namespace when one is supplied', () => {
    // The rules live in the gateway's namespace and the sandbox holds no
    // NET_ADMIN, so it is constrained by rules it cannot reach.
    const argv = containerCreateArgv({
      toolbox: toolboxOf(),
      network: {
        mode: 'allowlist',
        allow: ['10.0.0.0/8'],
        dns: [],
        proxyAllowHosts: [],
      },
      mount: { hostPath: '/h', containerPath: '/workspace' },
      containerName: 'c',
      gatewayContainer: 'ghost-netgate-1',
    });
    expect(argv).toContain('--network=container:ghost-netgate-1');
  });

  it('refuses a scoped sandbox with no gateway rather than running it wide open', () => {
    // Fail closed. An allow-list nothing enforces is indistinguishable from no
    // allow-list, and this is the failure that would otherwise look like success.
    expect(() =>
      create(
        {},
        {
          mode: 'allowlist',
          allow: ['10.0.0.0/8'],
          dns: [],
          proxyAllowHosts: [],
        },
      ),
    ).toThrow(GhostError);
    expect(() =>
      create(
        {},
        {
          mode: 'allowlist',
          allow: ['10.0.0.0/8'],
          dns: [],
          proxyAllowHosts: [],
        },
      ),
    ).toThrow(/open egress/);
  });

  it('uses the bridge for an open profile with no gateway', () => {
    expect(
      create({}, { mode: 'open', allow: [], dns: [], proxyAllowHosts: [] }),
    ).toContain('--network=bridge');
  });
});

describe('containerExecArgv', () => {
  const argv = (plan = planOf(), toolbox = toolboxOf()) =>
    containerExecArgv({ plan, toolbox, containerName: 'c', runId: 'r1' });

  it('passes the command as positional parameters, never inside the script', () => {
    // The script is a constant and the argv follows it as separate arguments, so
    // nothing the model wrote is ever parsed by a shell. This is the property the
    // whole `argv: string[]` contract exists to preserve.
    const result = argv();
    const script = result[result.indexOf('-c') + 1] ?? '';
    expect(script).not.toContain('nmap');
    expect(script).not.toContain('10.0.0.5');
    expect(result.slice(-3)).toEqual(['nmap', '-sV', '10.0.0.5']);
  });

  it('is unaffected by shell metacharacters in the arguments', () => {
    const result = argv(
      planOf({ args: ['$(whoami)', '`id`', '; rm -rf /', '&& curl evil'] }),
    );
    const script = result[result.indexOf('-c') + 1] ?? '';
    expect(script).toBe('echo $$ > "$1"; shift; exec "$@"');
    expect(result).toContain('$(whoami)');
    expect(result).toContain('; rm -rf /');
  });

  it('runs in the toolbox workdir', () => {
    expect(argv()).toContain('--workdir');
    expect(argv()[argv().indexOf('--workdir') + 1]).toBe('/workspace');
  });

  it('passes through only the environment names the profile lists', () => {
    // A host PATH inside a Kali container points at binaries that are not there,
    // and a secret the plan happened to carry has no business crossing at all.
    const result = argv(planOf(), toolboxOf({ env: ['LANG'] }));
    expect(result).toContain('LANG=en_GB.UTF-8');
    expect(result.join(' ')).not.toContain('SECRET');
    expect(result.join(' ')).not.toContain('PATH=/host/bin');
  });

  it('omits a name the profile lists but the plan does not carry', () => {
    // Absent rather than empty: an empty value would shadow the image's own.
    const result = argv(planOf(), toolboxOf({ env: ['TZ'] }));
    expect(result.join(' ')).not.toContain('TZ=');
  });

  it('writes the pid to a tmpfs, not to the read-only transcript mount', () => {
    // The transcript directory is mounted read-only so the agent cannot plant a
    // symlink there; the command therefore cannot write its pid into it either.
    expect(argv()).toContain('/tmp/.ghost-r1.pid');
    expect(argv().join(' ')).not.toContain('/workspace/.ghost');
  });

  it('reports the transcript at its read-only mount, outside the workspace', () => {
    expect(containerRunDir('ghost-sbx-1', 'x')).toBe(
      '/run/ghost-runs/ghost-sbx-1/x',
    );
  });

  it('keeps the transcript mount a sibling of the toolbox mount, never nested', () => {
    // `/run/ghost/runs` would need a mountpoint created inside a read-only mount,
    // which runc refuses outright.
    expect(RUNS_MOUNT_DIR.startsWith(`${TOOLBOX_MOUNT_DIR}/`)).toBe(false);
  });

  it('mounts the transcript directory read-only', () => {
    const argv = containerCreateArgv({
      toolbox: toolboxOf(),
      network: NONE,
      mount: { hostPath: '/h', containerPath: '/workspace' },
      containerName: 'c',
      runsPath: '/home/ghost/runs',
    });
    expect(argv).toContain(
      'type=bind,src=/home/ghost/runs,dst=/run/ghost-runs,ro',
    );
  });
});

describe('containerKillArgv', () => {
  it('signals the recorded pid inside the container', () => {
    // Killing the `docker exec` client on this side leaves the process running
    // on the other, which would break the one-signal-reaches-the-child invariant.
    const argv = containerKillArgv(
      { toolbox: toolboxOf(), containerName: 'c', runId: 'r1' },
      'TERM',
    );
    expect(argv).toContain('/tmp/.ghost-r1.pid');
    expect(argv).toContain('TERM');
    expect(argv[0]).toBe('exec');
  });

  it('takes the pid file as a parameter rather than interpolating it', () => {
    const argv = containerKillArgv(
      { toolbox: toolboxOf(), containerName: 'c', runId: 'r1' },
      'KILL',
    );
    const script = argv[argv.indexOf('-c') + 1] ?? '';
    expect(script).not.toContain('r1');
  });

  it('refuses to signal anything that is not a bare positive integer', () => {
    // The pid file is on a tmpfs the agent can write. `-1` would make the kill
    // signal every process in the namespace, including PID 1 — which stops the
    // container and leaves the pool serving an entry for something gone.
    const argv = containerKillArgv(
      { toolbox: toolboxOf(), containerName: 'c', runId: 'r1' },
      'TERM',
    );
    const script = argv[argv.indexOf('-c') + 1] ?? '';
    expect(script).toContain('*[!0-9]*');
  });
});

describe('containerRunner', () => {
  let base: string;
  let workspace: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-sbx-')));
    workspace = join(base, 'workspace');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function fakeInner(
    outcome: Partial<RunOutcome> = {},
  ): CommandRunner & { calls: RunRequest[] } {
    const calls: RunRequest[] = [];
    return {
      calls,
      async run(request) {
        calls.push(request);
        request.tee?.('stdout', Buffer.from('scan line one\n'));
        request.tee?.('stderr', Buffer.from('a warning\n'));
        return {
          stdout: 'scan line one\n',
          stderr: 'a warning\n',
          truncated: false,
          code: 0,
          signal: null,
          timedOut: false,
          ...outcome,
        };
      },
    };
  }

  it('writes the full transcript to the workspace and reports where it is', async () => {
    // The token win: the model is handed a path instead of the output, and the
    // output is not lost because the workspace is the shared mount.
    const inner = fakeInner();
    const runner = containerRunner({
      toolbox: toolboxOf(),
      containerName: 'c',
      runsRoot: workspace,
      nextRunId: () => 'run-1',
      inner,
    });

    const outcome = await runner.run({
      plan: planOf(),
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });

    expect(outcome.transcriptDir).toBe('/run/ghost-runs/c/run-1');
    expect(readFileSync(join(workspace, 'c/run-1/stdout.log'), 'utf8')).toBe(
      'scan line one\n',
    );
    expect(readFileSync(join(workspace, 'c/run-1/stderr.log'), 'utf8')).toBe(
      'a warning\n',
    );
  });

  it('runs the docker client rather than the guarded program', async () => {
    const inner = fakeInner();
    const runner = containerRunner({
      toolbox: toolboxOf(),
      containerName: 'c',
      runsRoot: workspace,
      nextRunId: () => 'r',
      inner,
      bin: 'podman',
    });

    await runner.run({
      plan: planOf(),
      timeoutMs: 0,
      signal: new AbortController().signal,
    });

    expect(inner.calls[0]?.plan.file).toBe('podman');
    expect(inner.calls[0]?.plan.args[0]).toBe('exec');
  });

  it('does not forward the host environment to the docker client beyond PATH', async () => {
    const inner = fakeInner();
    const runner = containerRunner({
      toolbox: toolboxOf(),
      containerName: 'c',
      runsRoot: workspace,
      nextRunId: () => 'r',
      inner,
    });

    await runner.run({
      plan: planOf(),
      timeoutMs: 0,
      signal: new AbortController().signal,
    });

    expect(Object.keys(inner.calls[0]?.plan.env ?? {})).toEqual(['PATH']);
  });

  it('signals the container when the command timed out', async () => {
    // The client returning is not the process ending: without this the command
    // keeps running after the turn believes it stopped it.
    const inner = fakeInner({ timedOut: true });
    const runner = containerRunner({
      toolbox: toolboxOf(),
      containerName: 'c',
      runsRoot: workspace,
      nextRunId: () => 'r',
      inner,
    });

    await runner.run({
      plan: planOf(),
      timeoutMs: 5,
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const kill = inner.calls.find((call) => call.plan.args.includes('KILL'));
    expect(kill).toBeDefined();
  });

  it('signals the container when the run threw', async () => {
    const calls: RunRequest[] = [];
    const inner: CommandRunner = {
      async run(request) {
        calls.push(request);
        if (calls.length === 1) throw new GhostError('tool', 'aborted');
        return {
          stdout: '',
          stderr: '',
          truncated: false,
          code: 0,
          signal: null,
          timedOut: false,
        };
      },
    };
    const runner = containerRunner({
      toolbox: toolboxOf(),
      containerName: 'c',
      runsRoot: workspace,
      nextRunId: () => 'r',
      inner,
    });

    await expect(
      runner.run({
        plan: planOf(),
        timeoutMs: 0,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(GhostError);
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.some((call) => call.plan.args.includes('TERM'))).toBe(true);
  });

  it('keeps the output budget for the model while the transcript stays whole', async () => {
    const inner = fakeInner();
    const runner = containerRunner({
      toolbox: toolboxOf(),
      containerName: 'c',
      runsRoot: workspace,
      nextRunId: () => 'r',
      inner,
    });

    await runner.run({
      plan: planOf({ maxOutputBytes: 64 }),
      timeoutMs: 0,
      signal: new AbortController().signal,
    });

    expect(inner.calls[0]?.plan.maxOutputBytes).toBe(64);
    expect(inner.calls[0]?.tee).toBeDefined();
  });
});

describe('openTranscript', () => {
  it('creates the run directory on the host before the container writes its pid', async () => {
    // On the host deliberately: creating it in the container script would race
    // the mount becoming visible.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-tr-')));
    try {
      const transcript = openTranscript(base, 'ghost-sbx-1', 'r9');
      transcript.write('stdout', Buffer.from('hello\n'));
      await transcript.close();
      expect(transcript.hostDir).toBe(join(base, 'ghost-sbx-1', 'r9'));
      expect(transcript.containerDir).toBe('/run/ghost-runs/ghost-sbx-1/r9');
      expect(readFileSync(join(transcript.hostDir, 'stdout.log'), 'utf8')).toBe(
        'hello\n',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('survives a workspace that disappears mid-run', async () => {
    // A disk filling up, or an operator deleting a workspace, must degrade to a
    // missing transcript rather than an uncaught stream error that ends the turn.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-tr-')));
    const transcript = openTranscript(base, 'c', 'gone');
    rmSync(base, { recursive: true, force: true });
    transcript.write('stdout', Buffer.from('into the void\n'));
    await expect(transcript.close()).resolves.toBeUndefined();
  });
});

/**
 * The distinction the pool acts on: the *container* failed, not the command.
 *
 * Both arrive as a non-zero exit with text on stderr, and getting it wrong in
 * either direction is bad in a different way. A missed detection tells the model
 * its own `nmap` invocation failed when `nmap` never ran, so it rewrites a
 * command that was already correct. A false positive throws away a container and
 * runs the command again — wasteful, and wrong if the command had side effects.
 */
describe('containerIsGone', () => {
  const gone = (stderr: string, code = 1): boolean =>
    containerIsGone({
      stdout: '',
      stderr,
      truncated: false,
      code,
      signal: null,
      timedOut: false,
    });

  it('recognises what each engine says when the container is not there', () => {
    expect(
      gone('Error response from daemon: No such container: ghost-sbx-1\n'),
    ).toBe(true);
    expect(
      gone(
        'Error response from daemon: Container ghost-sbx-1 is not running\n',
      ),
    ).toBe(true);
    expect(gone('Error: No such container: ghost-sbx-1\n')).toBe(true);
    expect(
      gone('Error: no container with name or ID "ghost-sbx-1" found\n'),
    ).toBe(true);
    expect(
      gone('Error: can only create exec sessions on running containers\n'),
    ).toBe(true);
  });

  it('leaves a command that merely printed one of those strings alone', () => {
    // Anchored at the start of stderr rather than searched for anywhere in it,
    // because the daemon writes its refusal *instead of* the command's output —
    // so the message is the whole of stderr when it is the daemon talking.
    expect(gone('grep: No such container: not found in any file\n')).toBe(
      false,
    );
    expect(
      gone('a warning\nError response from daemon: No such container: x\n'),
    ).toBe(false);
  });

  it('says nothing about a command that succeeded', () => {
    expect(gone('Error response from daemon: No such container: x\n', 0)).toBe(
      false,
    );
  });

  it('says nothing about a command that was killed', () => {
    // `code: null` means a signal ended it — a timeout or an abort — and the
    // pool's own kill path already owns that case.
    expect(
      containerIsGone({
        stdout: '',
        stderr: '',
        truncated: false,
        code: null,
        signal: 'SIGKILL',
        timedOut: true,
      }),
    ).toBe(false);
  });
});
