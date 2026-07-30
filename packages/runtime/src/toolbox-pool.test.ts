import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GhostError } from '@ghostai/core';
import { ToolboxStore } from '@ghostai/security';
import type { AgentToolboxNetwork } from '@ghostai/protocol';

import type { CommandRunner, RunOutcome, RunRequest, ToolboxRequest } from '@ghostai/tools';

import {
  OWNER_LABEL,
  ToolboxPool,
  ownerProcessLooksAlive,
  ownerTag,
  type ContainerEngine,
  type ToolboxPoolOptions,
} from './toolbox-pool.js';

const DIGEST = `sha256:${'c'.repeat(64)}`;

interface FakeEngine extends ContainerEngine {
  readonly started: string[][];
  readonly stopped: string[];
  failStart: boolean;
  reaped: number;
  failReap: boolean;
}

function fakeEngine(): FakeEngine {
  const started: string[][] = [];
  const stopped: string[] = [];
  return {
    started,
    stopped,
    failStart: false,
    reaped: 0,
    failReap: false,
    probe() {
      /* reachable */
    },
    reapOrphans() {
      if (this.failReap) throw new Error('cannot list');
      this.reaped += 1;
    },
    start(argv) {
      if (this.failStart) throw new Error('daemon said no');
      started.push([...argv]);
    },
    stop(name) {
      stopped.push(name);
    },
  };
}

let base: string;
let database: DatabaseSync;
let store: ToolboxStore;
let engine: FakeEngine;

function install(name: string, overrides: Record<string, unknown> = {}): void {
  mkdirSync(join(base, 'toolboxes', name), { recursive: true });
  writeFileSync(
    join(base, 'toolboxes', name, 'toolbox.json'),
    JSON.stringify({
      schema: 'ghostai.toolbox/1',
      name,
      image: DIGEST,
      network: { maxMode: 'open' },
      ...overrides,
    }),
  );
}

function request(overrides: Partial<ToolboxRequest> = {}): ToolboxRequest {
  const network: AgentToolboxNetwork = { mode: 'none', allow: [] };
  return {
    agentId: 'researcher',
    workspaceId: 'default',
    sessionKey: 'web:1',
    toolbox: 'research',
    network,
    workspaceRoot: join(base, 'workspace'),
    ...overrides,
  };
}

function pool(overrides: Partial<ToolboxPoolOptions> = {}): ToolboxPool {
  let counter = 0;
  return new ToolboxPool({
    toolboxes: store,
    engine,
    runsDir: join(base, 'runs'),
    newId: () => {
      counter += 1;
      return String(counter);
    },
    ...overrides,
  });
}

/** Enough of a `RunRequest` to reach a runner; nothing here inspects the plan. */
function runRequest(): RunRequest {
  return {
    plan: {
      file: 'echo',
      args: ['hi'],
      cwd: join(base, 'workspace'),
      env: {},
      timeoutMs: 1_000,
      maxOutputBytes: 1024,
      paths: [],
    },
    timeoutMs: 1_000,
    signal: new AbortController().signal,
  };
}

function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    stdout: 'hi',
    stderr: '',
    truncated: false,
    code: 0,
    signal: null,
    timedOut: false,
    ...overrides,
  };
}

/** What the daemon says when the container a session was warm on has gone. */
const GONE = outcome({
  code: 1,
  stdout: '',
  stderr: 'Error response from daemon: No such container: ghost-sbx-1\n',
});

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-pool-')));
  mkdirSync(join(base, 'workspace'), { recursive: true });
  database = new DatabaseSync(':memory:');
  store = new ToolboxStore({ database, dir: join(base, 'toolboxes') });
  engine = fakeEngine();
});

afterEach(() => {
  database.close();
  rmSync(base, { recursive: true, force: true });
});

describe('ToolboxPool', () => {
  it('does not touch the container runtime until a turn needs one', () => {
    // Constructing the pool happens at boot, for any install with a sandboxed
    // agent. `docker ps` against a dead-but-present socket blocks for a minute,
    // so a sweep here hung `ghost serve` before it bound its port.
    install('research');
    store.approve('research');
    pool();

    expect(engine.reaped).toBe(0);
    expect(engine.started).toHaveLength(0);
  });

  it('sweeps containers a previous process left behind, on first use', () => {
    // `close()` reaps what this process started and reaps nothing when the
    // process was killed outright. Without this, a crash leaks a container
    // holding a workspace mount, forever, silently.
    install('research');
    store.approve('research');
    const live = pool();

    live.forTurn(request());
    live.forTurn(request({ sessionKey: 'web:2' }));

    // Once, not per turn.
    expect(engine.reaped).toBe(1);
  });

  it('still runs the turn when the sweep fails', () => {
    // An orphan nobody could remove is untidy; refusing the turn over it would
    // make untidy into unusable.
    install('research');
    store.approve('research');
    engine.failReap = true;

    expect(() => pool().forTurn(request())).not.toThrow();
  });

  it('returns no runner for an agent that names no toolbox', () => {
    // `undefined` rather than a host runner, so `exec` keeps `localRunner` as
    // its own default and nothing here has to know what the host means.
    expect(pool().forTurn(request({ toolbox: '' }))).toBeUndefined();
    expect(engine.started).toHaveLength(0);
  });

  it('refuses a toolbox that was never approved', () => {
    install('research');
    expect(() => pool().forTurn(request())).toThrow(/never been approved/);
    expect(engine.started).toHaveLength(0);
  });

  it('starts a container once the toolbox is approved', () => {
    install('research');
    store.approve('research');

    const runner = pool().forTurn(request());

    expect(runner).toBeDefined();
    expect(engine.started).toHaveLength(1);
    expect(engine.started[0]?.[0]).toBe('run');
  });

  it('reuses the container for a second turn in the same session', () => {
    // The whole reason the pool exists: a Kali or research image costs seconds
    // to start, and a conversation should pay that once.
    install('research');
    store.approve('research');
    const live = pool();

    const first = live.forTurn(request());
    const second = live.forTurn(request());

    expect(second).toBe(first);
    expect(engine.started).toHaveLength(1);
  });

  it('gives two sessions two containers', () => {
    // Keyed on the session, not the agent: one engagement's artefacts must not
    // sit in another's /tmp.
    install('research');
    store.approve('research');
    const live = pool();

    live.forTurn(request({ sessionKey: 'web:1' }));
    live.forTurn(request({ sessionKey: 'web:2' }));

    expect(engine.started).toHaveLength(2);
    expect(live.live).toHaveLength(2);
  });

  it('gives two workspaces two containers, because the mount differs', () => {
    install('research');
    store.approve('research');
    const live = pool();

    live.forTurn(request({ workspaceId: 'default' }));
    live.forTurn(request({ workspaceId: 'clients' }));

    expect(engine.started).toHaveLength(2);
  });

  it('refuses rather than falling back to the host when the engine fails', () => {
    // The one failure mode where an operator believes there is a boundary and
    // there is not.
    install('research');
    store.approve('research');
    engine.failStart = true;

    expect(() => pool().forTurn(request())).toThrow(GhostError);
    expect(() => pool().forTurn(request())).toThrow(/could not be started/);
  });

  it('refuses a network request above the toolbox ceiling', () => {
    install('research', { network: { maxMode: 'none' } });
    store.approve('research');

    expect(() => pool().forTurn(request({ network: { mode: 'open', allow: [] } }))).toThrow(
      /permits at most/,
    );
  });

  it('stops a container that has gone idle', () => {
    install('research');
    store.approve('research');
    let now = 1_000;
    const live = pool({ idleMs: 500, clock: { now: () => now } as never });

    live.forTurn(request());
    now = 2_000;
    live.forTurn(request({ sessionKey: 'web:2' }));

    expect(engine.stopped).toHaveLength(1);
    expect(live.live).toHaveLength(1);
  });

  it('evicts the least recently used beyond the cap', () => {
    install('research');
    store.approve('research');
    const live = pool({ maxLive: 2 });

    live.forTurn(request({ sessionKey: 'a' }));
    live.forTurn(request({ sessionKey: 'b' }));
    live.forTurn(request({ sessionKey: 'c' }));

    expect(live.live).toHaveLength(2);
    expect(engine.stopped).toHaveLength(1);
  });

  it('stops every container a session owns when it ends', () => {
    install('research');
    store.approve('research');
    const live = pool();

    live.forTurn(request({ sessionKey: 'web:1', agentId: 'a' }));
    live.forTurn(request({ sessionKey: 'web:1', agentId: 'b' }));
    live.forTurn(request({ sessionKey: 'web:2', agentId: 'a' }));

    live.releaseSession('web:1');

    expect(engine.stopped).toHaveLength(2);
    expect(live.live).toHaveLength(1);
  });

  it('survives an engine that cannot stop a container', () => {
    // A container already gone is the common case, and a failed reap must not
    // take down the turn that triggered the sweep.
    install('research');
    store.approve('research');
    const live = pool();
    live.forTurn(request());
    engine.stop = () => {
      throw new Error('no such container');
    };

    expect(() => {
      live.close();
    }).not.toThrow();
    expect(live.live).toHaveLength(0);
  });

  it('translates the mount path for a containerised GhostAI', () => {
    // A bind path is resolved by the daemon, so asking for GhostAI's own view
    // would mount the host's path of that name — usually an empty directory.
    install('research');
    store.approve('research');
    const live = pool({ hostPath: () => '/host/data/workspace' });

    live.forTurn(request());

    expect(engine.started[0]?.join(' ')).toContain(
      'type=bind,src=/host/data/workspace,dst=/workspace',
    );
  });

  it('labels the container with its session, toolbox and owning process', () => {
    install('research');
    store.approve('research');
    pool().forTurn(request());

    const argv = engine.started[0]?.join(' ') ?? '';
    expect(argv).toContain('ghostai.session=web:1');
    expect(argv).toContain('ghostai.toolbox=research');
    // The owner is what lets a sweep tell an orphan from a peer's live
    // container. Without it, two GhostAI processes reap each other's work.
    expect(argv).toContain(`${OWNER_LABEL}=${ownerTag()}`);
  });
});

describe('ownerProcessLooksAlive', () => {
  it('recognises this very process', () => {
    expect(ownerProcessLooksAlive(ownerTag())).toBe(true);
  });

  it('reports a pid on this host that no longer exists', () => {
    // The only case that may answer `false`, and the only case where reaping is
    // safe: this host, a pid that is gone.
    expect(ownerProcessLooksAlive(`${hostname()}:${String(0x7fffffff)}`)).toBe(false);
  });

  it('spares an owner on another host, which it cannot ask about', () => {
    // A shared or remote daemon serves several hosts, and pid 42 on each of them
    // is a different process. Guessing here would kill live work.
    expect(ownerProcessLooksAlive('some-other-host:42')).toBe(true);
  });

  it('spares an owner it cannot parse', () => {
    expect(ownerProcessLooksAlive('nonsense')).toBe(true);
    expect(ownerProcessLooksAlive(`${hostname()}:not-a-pid`)).toBe(true);
    expect(ownerProcessLooksAlive(`${hostname()}:-1`)).toBe(true);
  });
});

describe('ToolboxPool: a container with a command in it', () => {
  /** A runner whose one command finishes when the test says so. */
  function heldRunner(): { runner: CommandRunner; finish: () => void } {
    let release: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      runner: {
        run: async () => {
          await started;
          return outcome();
        },
      },
      finish: () => {
        release?.();
      },
    };
  }

  it('is not stopped by the idle sweep', async () => {
    // `lastUsedMs` is stamped once per turn, so a twenty-minute scan looks idle
    // for nineteen of them. A sweep triggered by another session used to stop the
    // container that scan was running in, and the model was told its command
    // failed.
    install('research');
    store.approve('research');
    const held = heldRunner();
    let now = 1_000;
    const live = pool({
      idleMs: 500,
      clock: { now: () => now } as never,
      newRunner: () => held.runner,
    });

    const runner = live.forTurn(request());
    const running = runner?.run(runRequest());
    // Long enough that the idle cutoff has passed.
    now = 10_000;

    live.forTurn(request({ sessionKey: 'web:2' }));

    expect(engine.stopped).toHaveLength(0);
    expect(live.live).toHaveLength(2);

    held.finish();
    await running;

    // And once it finishes it is reapable again — on the timestamp the command
    // ended at, not the one the turn started at.
    now = 20_000;
    live.forTurn(request({ sessionKey: 'web:3' }));
    expect(engine.stopped).not.toHaveLength(0);
  });

  it('is not evicted to get under the cap', async () => {
    install('research');
    store.approve('research');
    const held = heldRunner();
    const live = pool({ maxLive: 1, newRunner: () => held.runner });

    const running = live.forTurn(request({ sessionKey: 'a' }))?.run(runRequest());
    live.forTurn(request({ sessionKey: 'b' }));

    // Over the cap on purpose: the cap stops containers accumulating *unused*,
    // and one with a command in it is not that.
    expect(live.live).toHaveLength(2);
    expect(engine.stopped).toHaveLength(0);

    held.finish();
    await running;
  });
});

describe('ToolboxPool: a container that disappeared', () => {
  it('is rebuilt, and the command runs rather than failing', async () => {
    // Docker Desktop restarting, `docker system prune`, an operator tidying up:
    // the container a warm session was bound to is gone, and `docker exec`
    // reports that as an ordinary non-zero exit. Passing it through told the
    // model that its own command had failed, so it rewrote a command that was
    // already correct.
    install('research');
    store.approve('research');
    const outcomes = [GONE, outcome({ stdout: 'ran on the new one' })];
    const live = pool({
      newRunner: () => ({
        run: async (): Promise<RunOutcome> => await Promise.resolve(outcomes.shift() ?? outcome()),
      }),
    });

    const result = await live.forTurn(request())?.run(runRequest());

    expect(result?.stdout).toBe('ran on the new one');
    expect(result?.code).toBe(0);
    expect(engine.started).toHaveLength(2);
    expect(live.live).toHaveLength(1);
  });

  it('keeps the turn on the same runner across the rebuild', async () => {
    // The turn holds whatever `forTurn` handed it for the whole turn, so a
    // runner bound to a container name could not survive the rebuild.
    install('research');
    store.approve('research');
    const outcomes = [GONE, outcome({ stdout: 'first' }), outcome({ stdout: 'second' })];
    const live = pool({
      newRunner: () => ({
        run: async (): Promise<RunOutcome> => await Promise.resolve(outcomes.shift() ?? outcome()),
      }),
    });

    const runner = live.forTurn(request());
    expect((await runner?.run(runRequest()))?.stdout).toBe('first');
    expect((await runner?.run(runRequest()))?.stdout).toBe('second');
  });

  it('gives up after one rebuild', async () => {
    // A second disappearance is something other than a stale handle, and a loop
    // that kept rebuilding would hide it behind a slow turn.
    install('research');
    store.approve('research');
    const live = pool({ newRunner: () => ({ run: async () => await Promise.resolve(GONE) }) });

    const result = await live.forTurn(request())?.run(runRequest());

    expect(result?.code).toBe(1);
    expect(engine.started).toHaveLength(2);
  });

  it('refuses instead of rebuilding a toolbox revoked in the meantime', async () => {
    // A rebuild is a new container, and it is subject to the same gate the first
    // one was.
    install('research');
    store.approve('research');
    const live = pool({ newRunner: () => ({ run: async () => await Promise.resolve(GONE) }) });
    const runner = live.forTurn(request());

    store.revoke('research');

    await expect(runner?.run(runRequest())).rejects.toThrow(/never been approved/);
  });
});

describe('ToolboxPool: edges', () => {
  it('never evicts the container it is about to hand back', () => {
    // With a cap this small the newest entry is the only entry, so an unguarded
    // sweep would stop the container whose runner is being returned — and every
    // exec would fail against something the pool reported starting.
    install('research');
    store.approve('research');
    const live = pool({ maxLive: 0 });

    const runner = live.forTurn(request());

    expect(runner).toBeDefined();
    expect(live.live).toHaveLength(1);
    expect(engine.stopped).toHaveLength(0);
  });

  it('releases only the session it was asked about', () => {
    // Matching used to be `key.endsWith(' ' + sessionKey)`, which reaps a
    // different session whose key happens to end with this one's text.
    install('research');
    store.approve('research');
    const live = pool();

    live.forTurn(request({ sessionKey: 'web:1' }));
    live.forTurn(request({ sessionKey: 'x web:1' }));

    live.releaseSession('web:1');

    expect(live.live).toHaveLength(1);
    expect(engine.stopped).toHaveLength(1);
  });

  it('translates the manifest mount as well as the workspace', () => {
    // A containerised GhostAI that translated only the workspace would ask the
    // daemon for its own /data/profiles path — which means something else on the
    // host. The container would start carrying the wrong policy file.
    install('research');
    store.approve('research');
    const live = pool({ hostPath: (path) => path.replace(base, '/host') });

    live.forTurn(request());

    const argv = engine.started[0]?.join(' ') ?? '';
    expect(argv).toContain('type=bind,src=/host/workspace,dst=/workspace');
    expect(argv).toContain('type=bind,src=/host/toolboxes/research,dst=/run/ghost,ro');
    expect(argv).not.toContain(base);
  });
});

describe('ToolboxPool: approval is re-checked every turn', () => {
  it('stops reusing a container once the toolbox is revoked', () => {
    // `ghost profiles revoke` is a different process writing the shared database,
    // so nothing notifies this pool. Asking `require` before the cache — not
    // after — is what makes revocation take effect on a warm session.
    install('research');
    store.approve('research');
    const live = pool();
    live.forTurn(request());

    store.revoke('research');

    expect(() => live.forTurn(request())).toThrow(/never been approved/);
  });

  it('replaces a container whose manifest changed under it', () => {
    // The running container was created with the old policy's flags, so reusing
    // it would run under a manifest nobody approved.
    install('research');
    store.approve('research');
    const live = pool();
    const first = live.forTurn(request());

    install('research', { network: { maxMode: 'open' }, version: '2.0.0' });
    store.approve('research');
    const second = live.forTurn(request());

    expect(second).not.toBe(first);
    expect(engine.stopped).toHaveLength(1);
    expect(engine.started).toHaveLength(2);
  });
});
