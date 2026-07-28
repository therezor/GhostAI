import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { defineTool } from '@ghostai/tools';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ProviderCache } from './provider-cache.js';
import { createRuntime, type GhostRuntime, type RuntimeOptions } from './runtime.js';

const homes: string[] = [];
const opened: GhostRuntime[] = [];
const databases: DatabaseSync[] = [];

function tempHome(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-runtime-'));
  homes.push(dir);
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

/** Every runtime here is closed in `afterEach`; SQLite would leak the handle. */
function build(options: RuntimeOptions = {}): GhostRuntime {
  const runtime = createRuntime({ vault: false, env: {}, ...options });
  opened.push(runtime);
  return runtime;
}

/** A runtime on a config file, with a provider and model already resolved. */
function ollama(
  defaults: Record<string, unknown> = {},
  options: RuntimeOptions = {},
): GhostRuntime {
  const home = tempHome({
    agents: { defaults: { provider: 'ollama', model: 'qwen3:8b', ...defaults } },
  });
  return build({ home, ...options });
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (databases.length > 0) databases.pop()?.close();
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createRuntime', () => {
  it('wires a loop from the config file', () => {
    const runtime = ollama();

    expect(runtime.spec?.id).toBe('ollama');
    expect(runtime.model).toBe('qwen3:8b');
    expect(runtime.requireLoop().model).toBe('qwen3:8b');
    expect(runtime.hasCredential).toBe(false);
    expect(runtime.tools.has('read_file')).toBe(true);
  });

  it('names the config file it read', () => {
    const home = tempHome();
    const runtime = build({ home, provider: 'ollama', model: 'm' });
    expect(runtime.file).toBe(join(home, 'config.json'));
  });

  it('starts with no tools at all when asked', () => {
    expect(ollama({}, { tools: false }).tools.size).toBe(0);
  });

  it('builds unconfigured when nothing names a provider, and refuses only the turn', () => {
    // Everything but the loop is useful without a model, and refusing to
    // construct is what used to make `ghost serve` unable to come up on a bare
    // machine — leaving the settings UI that would fix it unreachable.
    const runtime = build({ home: tempHome() });

    expect(runtime.configured).toBe(false);
    expect(runtime.loop).toBeNull();
    expect(runtime.spec).toBeNull();
    expect(runtime.tools.has('read_file')).toBe(true);
    expect(runtime.jail.root).not.toBe('');

    // `resolveInstance` returns null rather than picking one, and a request
    // landing at an endpoint nobody chose fails as a 401 from somewhere
    // unexpected — so the turn stops and says what to set.
    expect(() => runtime.requireLoop()).toThrow(/No provider could be resolved/);
  });

  it('reports a provider with no model as unconfigured, naming the provider', () => {
    const home = tempHome({ agents: { defaults: { provider: 'ollama' } } });
    const runtime = build({ home });

    expect(runtime.configured).toBe(false);
    expect(runtime.instance?.id).toBe('ollama');
    expect(() => runtime.requireLoop()).toThrow(/No model configured for Ollama/);
  });

  it('becomes configured when a reconfigure supplies what was missing', () => {
    const runtime = build({ home: tempHome() });
    expect(runtime.configured).toBe(false);

    runtime.reconfigure({
      providers: { 'ollama-gpu': { type: 'ollama', apiBase: 'http://gpu.lan:11434/v1' } },
      agents: { defaults: { provider: 'ollama-gpu', model: 'qwen3:8b' } },
    });

    expect(runtime.configured).toBe(true);
    expect(runtime.instance?.id).toBe('ollama-gpu');
    expect(runtime.requireLoop().model).toBe('qwen3:8b');
  });

  it('resolves one of two instances of the same provider type', () => {
    const home = tempHome({
      providers: {
        laptop: { type: 'ollama', apiBase: 'http://127.0.0.1:11434/v1' },
        gpu: { type: 'ollama', label: 'GPU box', apiBase: 'http://gpu.lan:11434/v1' },
      },
      agents: { defaults: { provider: 'gpu', model: 'qwen3:8b' } },
    });
    const runtime = build({ home });

    expect(runtime.instance?.id).toBe('gpu');
    expect(runtime.instance?.config.apiBase).toBe('http://gpu.lan:11434/v1');
    expect(runtime.spec?.id).toBe('ollama');
  });

  it('takes an exported API key as the operator naming a provider', () => {
    const runtime = build({
      home: tempHome(),
      model: 'some-model',
      env: { OPENAI_API_KEY: 'sk-test' },
    });

    expect(runtime.spec?.id).toBe('openai');
    expect(runtime.hasCredential).toBe(true);
  });

  it('resolves the workspace from the config, relative to the home', () => {
    const home = tempHome({
      agents: { defaults: { provider: 'ollama', model: 'm', workspace: 'projects/alpha' } },
    });
    const runtime = build({ home });

    expect(runtime.paths.workspace).toBe(resolve(home, 'projects/alpha'));
    // The jail canonicalises through `realpath`, which on macOS turns the
    // temp directory into its `/private` form.
    expect(runtime.jail.root).toBe(realpathSync(resolve(home, 'projects/alpha')));
  });

  it('lets an explicit workspace win over the config', () => {
    const workspace = join(tempHome(), 'from-flag');
    const runtime = ollama({ workspace: 'from-config' }, { workspace });

    expect(runtime.paths.workspace).toBe(workspace);
  });
});

describe('createRuntime over a borrowed connection', () => {
  function sharedDatabase(): DatabaseSync {
    const database = new DatabaseSync(join(tempHome(), 'shared.db'));
    databases.push(database);
    return database;
  }

  it('leaves a borrowed connection open when the runtime closes', () => {
    // The acceptance criterion for the extraction: the server's auth store, the
    // scheduler and a runtime all share one `DatabaseSync`, and building or
    // discarding a runtime must not take the connection with it.
    const database = sharedDatabase();
    const first = ollama({}, { database });
    const second = ollama({}, { database });

    first.store.ensureSession('a');
    first.close();

    second.store.ensureSession('b');
    expect(second.store.messageCount('a')).toBe(0);
    expect(database.prepare('select count(*) as n from sessions').get()).toEqual({ n: 2 });
  });

  it('opens its own file when no connection is borrowed', () => {
    const home = tempHome({ agents: { defaults: { provider: 'ollama', model: 'm' } } });
    const runtime = build({ home });

    runtime.store.ensureSession('cli:default');
    expect(runtime.store.messageCount('cli:default')).toBe(0);
    expect(runtime.paths.dbFile).toBe(join(home, 'ghost.db'));
  });
});

describe('reconfigure', () => {
  it('moves the model and rebuilds the loop, keeping the store', () => {
    const runtime = ollama();
    const store = runtime.store;
    const before = runtime.loop;

    const config = runtime.reconfigure({ agents: { defaults: { model: 'llama3' } } });

    expect(config.agents.defaults.model).toBe('llama3');
    expect(runtime.model).toBe('llama3');
    expect(runtime.requireLoop().model).toBe('llama3');
    expect(runtime.loop).not.toBe(before);
    expect(runtime.store).toBe(store);
  });

  it('leaves a construction-time override in place', () => {
    // `ghost chat --model x` is a statement about this process; a settings save
    // from a browser must not move the terminal session onto another model.
    const runtime = ollama({}, { model: 'pinned' });
    runtime.reconfigure({ agents: { defaults: { model: 'llama3' } } });

    expect(runtime.model).toBe('pinned');
    expect(runtime.config.agents.defaults.model).toBe('llama3');
  });

  it('re-registers the built-ins so a disabled exec disappears', () => {
    // A disabled tool the model can still see costs it a turn to discover.
    const runtime = ollama();
    expect(runtime.tools.has('exec')).toBe(true);

    runtime.reconfigure({ tools: { exec: { enable: false } } });
    expect(runtime.tools.has('exec')).toBe(false);
    expect(runtime.tools.has('read_file')).toBe(true);

    runtime.reconfigure({ tools: { exec: { enable: true } } });
    expect(runtime.tools.has('exec')).toBe(true);
  });

  it('keeps registrations that are not built-ins', () => {
    // The reason the registry survives a rebuild: an MCP server's tools are not
    // something the operator asked to drop by editing a temperature.
    const runtime = ollama();
    runtime.tools.register(
      defineTool({
        name: 'mcp_demo_echo',
        description: 'echo',
        schema: z.strictObject({ text: z.string() }),
        execute: ({ text }) => text,
      }),
      'mcp',
    );

    runtime.reconfigure({ agents: { defaults: { temperature: 0.9 } } });
    expect(runtime.tools.has('mcp_demo_echo')).toBe(true);
  });

  it('applies a new tool timeout to the live registry', () => {
    const runtime = ollama();
    runtime.reconfigure({ agents: { defaults: { toolTimeoutMs: 5_000 } } });
    expect(runtime.tools.timeoutMs).toBe(5_000);
  });

  it('keeps the steering queue, so a correction queued mid-turn survives', () => {
    const runtime = ollama();
    runtime.requireLoop().steer('s1', 'actually, use TypeScript');

    runtime.reconfigure({ agents: { defaults: { temperature: 0.2 } } });

    expect(runtime.requireLoop().steering).toBe(runtime.steering);
    expect(runtime.steering.drain('s1')).toHaveLength(1);
  });

  it('moves the jail when the workspace moves, and reuses it when it does not', () => {
    const runtime = ollama();
    const jail = runtime.jail;

    runtime.reconfigure({ agents: { defaults: { temperature: 0.4 } } });
    expect(runtime.jail).toBe(jail);

    const moved = join(tempHome(), 'elsewhere');
    runtime.reconfigure({ agents: { defaults: { workspace: moved } } });
    expect(runtime.jail).not.toBe(jail);
    expect(runtime.paths.workspace).toBe(moved);
    expect(runtime.jail.root).toBe(realpathSync(moved));
  });

  it('reuses the cached adapter when nothing about the connection changed', () => {
    const providers = new ProviderCache();
    const runtime = ollama({}, { providers });

    runtime.reconfigure({ agents: { defaults: { temperature: 0.4 } } });
    expect(providers.size).toBe(1);

    runtime.reconfigure({
      providers: { ollama: { type: 'ollama', apiBase: 'http://127.0.0.1:9999/v1' } },
    });
    expect(providers.size).toBe(2);
  });

  it('leaves an injected cache alone on close', () => {
    // The cache outlives the runtime when the caller supplied it; closing its
    // adapters would pull the pool out from under another runtime's turn.
    const providers = new ProviderCache();
    const runtime = ollama({}, { providers });
    runtime.close();
    expect(providers.size).toBe(1);
  });

  it('changes nothing when the patch cannot be built', () => {
    const runtime = ollama();
    const before = runtime.loop;

    expect(() => runtime.reconfigure({ agents: { defaults: { provider: 'anthropic' } } })).toThrow(
      /anthropic-messages/,
    );

    expect(runtime.loop).toBe(before);
    expect(runtime.spec?.id).toBe('ollama');
    expect(runtime.config.agents.defaults.provider).toBe('ollama');
    expect(runtime.tools.has('read_file')).toBe(true);
  });

  it('rejects a patch the schema refuses without touching the runtime', () => {
    const runtime = ollama();
    expect(() => runtime.reconfigure({ agents: { defaults: { temperature: 40 } } })).toThrow(
      /agents\.defaults\.temperature/,
    );
    expect(runtime.config.agents.defaults.temperature).toBe(0.1);
  });

  it('goes back to unconfigured when the model is cleared out of the config', () => {
    // A settings save that empties the model is not a failed reconfigure — it
    // is an install that is no longer able to run a turn, and the server has to
    // keep serving everything else while the operator picks a new one.
    const runtime = ollama();
    expect(runtime.configured).toBe(true);

    runtime.reconfigure({ agents: { defaults: { model: '' } } });

    expect(runtime.configured).toBe(false);
    expect(runtime.loop).toBeNull();
    expect(() => runtime.requireLoop()).toThrow(/No model configured/);
  });

  it('picks up a credential saved since the runtime was built', () => {
    // The settings panel writes a key to the vault and expects the next turn to
    // use it — which is why the credential is read on every build rather than
    // captured once.
    const home = tempHome();
    const vault = new Map<string, string>();
    const fakeVault = {
      get: (namespace: string, key: string) => vault.get(`${namespace}/${key}`),
    } as never;

    const runtime = build({
      home,
      provider: 'openai',
      model: 'gpt-4o',
      vault: fakeVault,
    });
    expect(runtime.hasCredential).toBe(false);

    vault.set('providers/openai', 'sk-typed-in-the-ui');
    runtime.reconfigure({ agents: { defaults: { temperature: 0.2 } } });
    expect(runtime.hasCredential).toBe(true);
  });
});
