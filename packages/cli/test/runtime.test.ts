import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveGhostPaths } from '@ghostai/core';
import { findProvider, type ProviderInstance } from '@ghostai/providers';
import { CredentialVault } from '@ghostai/security';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_CREDENTIAL_NAMESPACE,
  createChatRuntime,
  findCredential,
  type ChatRuntime,
} from '#src/runtime.js';

const homes: string[] = [];
const opened: ChatRuntime[] = [];

function tempHome(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-cli-'));
  homes.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  }
  return dir;
}

/** Every runtime here is closed in `afterEach`; SQLite would leak the handle. */
function build(...args: Parameters<typeof createChatRuntime>): ChatRuntime {
  const runtime = createChatRuntime(...args);
  opened.push(runtime);
  return runtime;
}

/** An instance of `type`, named `id` — which defaults to the type, as a migrated config would. */
function instance(type: string, id = type): ProviderInstance {
  const found = findProvider(type);
  if (found === null) throw new Error(`no such provider: ${type}`);
  return {
    id,
    spec: found,
    config: { type, label: '', extraHeaders: {}, models: [], enabled: true },
  };
}

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('findCredential', () => {
  const paths = resolveGhostPaths({ root: '/nowhere', env: {} });

  it('does not open a vault that does not exist yet', () => {
    // The point: `resolveVaultKey` writes a key to the OS keychain the first
    // time it runs, and `ghost chat` against Ollama must not create one.
    expect(
      findCredential(instance('ollama'), paths, {}, undefined),
    ).toBeUndefined();
  });

  it('prefers the vault over an exported environment variable', () => {
    const dir = tempHome();
    const vault = new CredentialVault({
      file: join(dir, 'vault.json'),
      key: Buffer.alloc(32, 7),
    });
    vault.set(PROVIDER_CREDENTIAL_NAMESPACE, 'openai', 'from-vault');

    const found = findCredential(
      instance('openai'),
      paths,
      { OPENAI_API_KEY: 'from-env' },
      vault,
    );
    expect(found).toBe('from-vault');
  });

  it('falls back to the environment when the vault holds nothing', () => {
    const dir = tempHome();
    const vault = new CredentialVault({
      file: join(dir, 'vault.json'),
      key: Buffer.alloc(32, 7),
    });

    expect(
      findCredential(
        instance('openai'),
        paths,
        { OPENAI_API_KEY: 'from-env' },
        vault,
      ),
    ).toBe('from-env');
  });

  it('treats an empty variable as absent rather than as an empty key', () => {
    expect(
      findCredential(instance('openai'), paths, { OPENAI_API_KEY: '' }, false),
    ).toBeUndefined();
  });
});

describe('createChatRuntime', () => {
  it('uses the provider and model named on the command line', () => {
    const runtime = build({
      home: tempHome(),
      provider: 'ollama',
      model: 'qwen3:8b',
      vault: false,
    });

    expect(runtime.spec?.id).toBe('ollama');
    expect(runtime.model).toBe('qwen3:8b');
    expect(runtime.requireLoop().model).toBe('qwen3:8b');
    expect(runtime.hasCredential).toBe(false);
  });

  it('reads the provider and model from the config file', () => {
    const home = tempHome({
      agents: { defaults: { provider: 'ollama', model: 'llama3' } },
    });
    const runtime = build({ home, vault: false, env: {} });

    expect(runtime.spec?.id).toBe('ollama');
    expect(runtime.model).toBe('llama3');
  });

  it('refuses the turn, not the runtime, when nothing names a provider', () => {
    // `resolveInstance` returns null rather than picking one, and a request
    // landing at an endpoint nobody chose fails as a 401 from somewhere
    // unexpected — so the turn stops and says what to set. The runtime itself
    // still builds, because `ghost serve` shares it and has to come up.
    const home = tempHome();
    const runtime = build({ home, vault: false, env: {} });

    expect(runtime.configured).toBe(false);
    expect(() => runtime.requireLoop()).toThrow(
      /No provider could be resolved/,
    );
    expect(() => runtime.requireLoop()).toThrow(/ghost init/);
  });

  it('takes an exported API key as the operator naming a provider', () => {
    const runtime = build({
      home: tempHome(),
      model: 'some-model',
      vault: false,
      env: { OPENAI_API_KEY: 'sk-test' },
    });

    expect(runtime.spec?.id).toBe('openai');
    expect(runtime.hasCredential).toBe(true);
  });

  it('names the file to edit when a provider resolves but a model does not', () => {
    const home = tempHome();
    const runtime = build({ home, provider: 'ollama', vault: false, env: {} });

    expect(() => runtime.requireLoop()).toThrow(/No model configured/);
    expect(() => runtime.requireLoop()).toThrow(
      new RegExp(join(home, 'config.json').replaceAll('\\', '\\\\')),
    );
  });

  it('resolves the workspace from the config, relative to the home', () => {
    const home = tempHome({
      agents: { defaults: { workspace: 'projects/alpha' } },
    });
    const runtime = build({
      home,
      provider: 'ollama',
      model: 'm',
      vault: false,
      env: {},
    });

    expect(runtime.paths.workspace).toBe(resolve(home, 'projects/alpha'));
  });

  it('lets an explicit workspace win over the config', () => {
    const home = tempHome({
      agents: { defaults: { workspace: 'from-config' } },
    });
    const workspace = join(tempHome(), 'from-flag');
    const runtime = build({
      home,
      workspace,
      provider: 'ollama',
      model: 'm',
      vault: false,
    });

    expect(runtime.paths.workspace).toBe(workspace);
  });

  it('surfaces a provider whose wire has no adapter as a config error', () => {
    const home = tempHome();
    expect(() =>
      build({
        home,
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        vault: false,
        env: {},
      }),
    ).toThrow(/anthropic-messages/);
  });

  it('honours a configured apiBase over the registry default', () => {
    const home = tempHome({
      agents: { defaults: { provider: 'ollama', model: 'm' } },
      providers: {
        ollama: { type: 'ollama', apiBase: 'http://127.0.0.1:9999/v1' },
      },
    });
    // Nothing observable on the runtime exposes the base URL, so the assertion
    // that matters is that an override parses and constructs at all — an
    // unusable base is a throw from `assertUsableApiBase`.
    expect(() => build({ home, vault: false, env: {} })).not.toThrow();
  });

  it('opens the session database under the resolved home', () => {
    const home = tempHome();
    const runtime = build({
      home,
      provider: 'ollama',
      model: 'm',
      vault: false,
      env: {},
    });

    runtime.store.ensureSession('cli:default');
    expect(runtime.store.messageCount('cli:default')).toBe(0);
    expect(runtime.paths.dbFile).toBe(join(home, 'ghost.db'));
  });
});
