/**
 * Status, settings, credentials, providers, models and tools.
 *
 * Sessions, files and notifications have their own files — the route surface is
 * twenty-nine endpoints and one test file for all of them would be a file nobody
 * reads.
 */

import {
  ConfigSchema,
  PROTOCOL_VERSION,
  type ProvidersResponse,
  type ToolDefinition,
} from '@ghostai/protocol';
import { GhostError } from '@ghostai/core';
import { PROVIDERS } from '@ghostai/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_VERSION } from './version.js';
import { startTestServer, type TestServer } from './testkit/server.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start(...args: Parameters<typeof startTestServer>): Promise<TestServer> {
  const started = await startTestServer(...args);
  running.push(started);
  return started;
}

const READ_FILE: ToolDefinition = {
  name: 'read_file',
  description: 'Read a file',
  parameters: { type: 'object', properties: {} },
  risk: 'safe',
  source: 'builtin',
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('GET /api/status', () => {
  it('reports what a turn would use right now', async () => {
    const { server, headers } = await start({
      provider: 'anthropic',
      configured: true,
      model: 'claude-sonnet-4',
      tools: [READ_FILE],
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/status', headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      version: SERVER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: expect.any(Number),
      model: 'claude-sonnet-4',
      provider: 'anthropic',
      configured: true,
      workspaceId: 'default',
      workspaceCount: 1,
      authEnabled: true,
      toolCount: 1,
      mcpServersConnected: 0,
      pluginsLoaded: 0,
    });
  });

  it('reports a fresh install as unconfigured, without failing', async () => {
    // The whole point of the state: everything but a turn works, so the client
    // can render the app and point at setup rather than at an error page.
    const { server, headers } = await start({ configured: false, provider: '', model: '' });
    const response = await server.app.inject({ method: 'GET', url: '/api/status', headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ configured: false, provider: '', model: '' });
  });

  // The model is read through the runtime rather than snapshotted at boot, so a
  // settings save that moved it is visible here rather than only in the answer
  // that comes back from the wrong model.
  it('follows a settings save rather than the boot config', async () => {
    const { server, headers, runtime } = await start({ model: 'first' });

    const original = runtime.agent();
    Object.assign(runtime, { agent: () => ({ ...original, model: 'second' }) });
    const response = await server.app.inject({ method: 'GET', url: '/api/status', headers });

    expect(response.json().model).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
  it('returns the settings tree and presence flags', async () => {
    const { server, headers } = await start({ credentialsPresent: { openai: true } });
    const response = await server.app.inject({ method: 'GET', url: '/api/settings', headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      config: { agents: { defaults: { provider: 'auto' } } },
      credentialsPresent: { openai: true },
    });
  });

  // The one property this route exists to hold. `credentialsPresent` says a key
  // is configured; nothing in the body says what it is.
  it('never returns a credential', async () => {
    const { server, headers, runtime } = await start();
    await server.app.inject({
      method: 'PUT',
      url: '/api/settings/credentials',
      headers,
      payload: { namespace: 'providers', key: 'openai', value: 'sk-the-actual-secret' },
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/settings', headers });

    expect(response.payload).not.toContain('sk-the-actual-secret');
    expect(response.json().credentialsPresent.openai).toBe(true);
    expect(runtime.credentialWrites).toEqual([
      { namespace: 'providers', key: 'openai', value: 'sk-the-actual-secret' },
    ]);
  });

  it('reports a config file that failed to parse', async () => {
    const { server, headers, runtime } = await start();
    Object.assign(runtime, { loadError: () => 'config.json is not valid JSON' });

    const response = await server.app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(response.json().loadError).toMatch(/not valid JSON/);
  });
});

describe('PATCH /api/settings', () => {
  it('applies a deep patch without rewriting untouched fields', async () => {
    const { server, headers, runtime } = await start();

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { agents: { defaults: { temperature: 0.9 } } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().config.agents.defaults.temperature).toBe(0.9);
    // Untouched siblings keep their values rather than being reset to defaults,
    // which is the whole reason `ConfigPatch` is not `ConfigSchema.partial()`.
    expect(response.json().config.agents.defaults.maxToolIterations).toBe(40);
    expect(runtime.patches).toEqual([{ agents: { defaults: { temperature: 0.9 } } }]);
  });

  it('serves the patched settings on the next read', async () => {
    const { server, headers } = await start();
    await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { agents: { defaults: { model: 'a-new-model' } } },
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(response.json().config.agents.defaults.model).toBe('a-new-model');
  });

  it('rejects a patch whose settings could never boot', async () => {
    const { server, headers, runtime } = await start({
      config: ConfigSchema.parse({ server: { host: '0.0.0.0' } }),
    });

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { server: { auth: { enabled: false } } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Refusing to start/);
    // Refused *before* anything was applied: a save that cannot be served must
    // not leave the running server half-moved onto it.
    expect(runtime.patches).toEqual([]);
  });

  it('reports a malformed patch as a 422 pointing at the field', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { agents: { defaults: { temperature: 'warm' } } },
    });

    expect(response.statusCode).toBe(422);
    expect(Object.keys(response.json().error.details)).toEqual(['/agents/defaults/temperature']);
  });
});

describe('POST /api/settings/reload', () => {
  it('re-reads the file and answers with what it is now serving', async () => {
    const edited = ConfigSchema.parse({ agents: { defaults: { model: 'edited-by-hand' } } });
    const { server, headers, runtime } = await start({ onReload: () => edited });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/settings/reload',
      headers,
    });

    expect(response.statusCode).toBe(200);
    // The answer is the settings tree, not `{ ok: true }`: the question behind
    // the press is "what is it running now", and a bare acknowledgement sends
    // the caller straight back for it.
    expect(response.json().config.agents.defaults.model).toBe('edited-by-hand');
    expect(runtime.reloads).toHaveLength(1);
  });

  it('serves the reloaded settings on the next read', async () => {
    const edited = ConfigSchema.parse({ agents: { defaults: { temperature: 0.9 } } });
    const { server, headers } = await start({ onReload: () => edited });
    await server.app.inject({ method: 'POST', url: '/api/settings/reload', headers });

    const response = await server.app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(response.json().config.agents.defaults.temperature).toBe(0.9);
  });

  it('reports a file that cannot be built, still serving the settings it had', async () => {
    const { server, headers } = await start({
      onReload: () => {
        throw new GhostError('config', 'config.json is not valid JSON');
      },
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/settings/reload',
      headers,
    });

    // 500 with the operator's own message, not the opaque one: a `GhostError`
    // is written for whoever has to fix the file.
    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toMatch(/not valid JSON/);

    // The rebuild failed, so the server is still on what it was serving — which
    // is the difference between a reload and a restart.
    const settings = await server.app.inject({ method: 'GET', url: '/api/settings', headers });
    expect(settings.statusCode).toBe(200);
  });
});

describe('PUT /api/settings/credentials', () => {
  it('stores a credential and answers with no body', async () => {
    const { server, headers, runtime } = await start();
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/settings/credentials',
      headers,
      payload: { namespace: 'providers', key: 'groq', value: 'gsk_secret' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.payload).toBe('');
    expect(runtime.credentialsPresent().groq).toBe(true);
  });

  it('deletes with a null value', async () => {
    const { server, headers, runtime } = await start({ credentialsPresent: { groq: true } });
    await server.app.inject({
      method: 'PUT',
      url: '/api/settings/credentials',
      headers,
      payload: { namespace: 'providers', key: 'groq', value: null },
    });

    expect(runtime.credentialsPresent().groq).toBe(false);
  });

  it('refuses a namespace outside the known set', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'PUT',
      url: '/api/settings/credentials',
      headers,
      payload: { namespace: 'somewhere-else', key: 'k', value: 'v' },
    });

    expect(response.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Providers and models
// ---------------------------------------------------------------------------

describe('GET /api/providers', () => {
  it('describes every provider type in the registry', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({ method: 'GET', url: '/api/providers', headers });

    const { types } = response.json<ProvidersResponse>();
    expect(types).toHaveLength(PROVIDERS.length);
    expect(types.find((type) => type.id === 'openai')).toMatchObject({
      displayName: 'OpenAI',
      wire: 'openai-chat',
      supportsModelListing: true,
    });
    // The catalogue carries no credential flag: a credential belongs to a
    // configured endpoint, and two instances of one type can differ.
    expect(types.find((type) => type.id === 'openai')).not.toHaveProperty('credentialsPresent');
  });

  it('lists the configured instances, with a credential flag each', async () => {
    const { server, headers } = await start({
      credentialsPresent: { 'ollama-gpu': true },
      config: ConfigSchema.parse({
        providers: {
          ollama: { type: 'ollama' },
          'ollama-gpu': { type: 'ollama', label: 'GPU box', apiBase: 'http://gpu.lan:11434/v1' },
        },
      }),
    });
    const response = await server.app.inject({ method: 'GET', url: '/api/providers', headers });

    const { instances } = response.json<ProvidersResponse>();
    expect(instances.map((instance) => instance.id)).toEqual(['ollama', 'ollama-gpu']);
    expect(instances[0]).toMatchObject({
      type: 'ollama',
      displayName: 'Ollama',
      // The effective endpoint, with the type's default folded in.
      apiBase: 'http://127.0.0.1:11434/v1',
      credentialsPresent: false,
    });
    expect(instances[1]).toMatchObject({
      displayName: 'GPU box',
      apiBase: 'http://gpu.lan:11434/v1',
      credentialsPresent: true,
    });
  });
});

describe('POST /api/providers/test', () => {
  it('passes the connection through and answers with the verdict', async () => {
    const { server, headers, runtime } = await start();
    const asked: unknown[] = [];
    Object.assign(runtime, {
      testProvider: async (request: unknown) => {
        asked.push(request);
        return { ok: true, models: ['llama3'] };
      },
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/providers/test',
      headers,
      payload: { type: 'ollama', apiBase: 'http://gpu.lan:11434/v1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, models: ['llama3'] });
    expect(asked).toEqual([
      // The schema's defaults arrive filled in, so the runtime never has to ask
      // whether an absent `extraHeaders` meant none or meant the spec's.
      { type: 'ollama', apiBase: 'http://gpu.lan:11434/v1', extraHeaders: {} },
    ]);
  });

  it('reports a rejected key as a result, not as an error envelope', async () => {
    // The distinction the whole route exists for: "it answered and refused the
    // key" is an answer to the question asked, and a 4xx would make the client
    // unpick an error to find it.
    const { server, headers, runtime } = await start();
    Object.assign(runtime, {
      testProvider: async () => ({
        ok: false,
        models: [],
        reason: 'auth',
        message: 'the key was rejected',
      }),
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/providers/test',
      headers,
      payload: { type: 'openai' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('degrades rather than failing when the runtime cannot probe', async () => {
    // A route test has no business opening a socket, so `testProvider` is
    // optional on the port — and an install without one gets an honest "cannot
    // be checked" instead of a 501 the panel would render as a fault.
    const { server, headers } = await start();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/providers/test',
      headers,
      payload: { type: 'openai' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: false, reason: 'unsupported' });
  });
});

describe('GET /api/models', () => {
  it('lists what the settings name, plus the model in use', async () => {
    const { server, headers } = await start({
      provider: 'ollama',
      model: 'qwen3',
      config: ConfigSchema.parse({
        providers: { openai: { type: 'openai', models: ['gpt-5', 'gpt-5-mini'] } },
      }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/models', headers });

    expect(response.json()).toEqual({
      // Sorted by provider then model, so a settings panel renders a stable
      // list rather than one that reorders when a model is added.
      models: [
        { id: 'qwen3', providerId: 'ollama' },
        { id: 'gpt-5', providerId: 'openai', providerType: 'openai' },
        { id: 'gpt-5-mini', providerId: 'openai', providerType: 'openai' },
      ],
      // Empty rather than one "not fetched" entry per provider: `errors` is for
      // a list that was attempted and failed.
      errors: {},
    });
  });

  it('merges an enumerated catalogue over the configured one', async () => {
    // The union, not either alone: a fetch that failed must leave whatever the
    // operator typed, or the picker empties itself the moment a laptop closes.
    const { server, headers, runtime } = await start({
      provider: 'ollama',
      model: 'qwen3',
      config: ConfigSchema.parse({
        providers: { openai: { type: 'openai', models: ['typed-by-hand'] } },
      }),
    });
    Object.assign(runtime, {
      models: async () => ({
        models: [{ id: 'from-the-provider', providerId: 'openai' }],
        errors: { groq: 'connection refused' },
      }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/models', headers });

    expect(response.json()).toEqual({
      models: [
        { id: 'qwen3', providerId: 'ollama' },
        { id: 'from-the-provider', providerId: 'openai' },
        { id: 'typed-by-hand', providerId: 'openai', providerType: 'openai' },
      ],
      errors: { groq: 'connection refused' },
    });
  });

  it('offers nothing for the agent when no model is configured', async () => {
    const { server, headers } = await start({ configured: false, provider: '', model: '' });
    const response = await server.app.inject({ method: 'GET', url: '/api/models', headers });
    expect(response.json()).toEqual({ models: [], errors: {} });
  });

  it('asks the runtime to bypass its cache on refresh', async () => {
    const { server, headers, runtime } = await start();
    const asked: (boolean | undefined)[] = [];
    Object.assign(runtime, {
      models: async (options?: { refresh?: boolean }) => {
        asked.push(options?.refresh);
        return { models: [], errors: {} };
      },
    });

    await server.app.inject({ method: 'GET', url: '/api/models', headers });
    await server.app.inject({ method: 'POST', url: '/api/models/refresh', headers });

    expect(asked).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('GET /api/tools', () => {
  it('returns the live registry rather than the settings tree', async () => {
    const { server, headers } = await start({ tools: [READ_FILE] });
    const response = await server.app.inject({ method: 'GET', url: '/api/tools', headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tools: [READ_FILE] });
  });

  it('answers with an empty list when the agent has no tools', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({ method: 'GET', url: '/api/tools', headers });

    expect(response.json()).toEqual({ tools: [] });
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  it('lists the default agent on an install that named none', async () => {
    const { server, headers } = await start({ provider: 'ollama', model: 'qwen3:8b' });
    const response = await server.app.inject({ method: 'GET', url: '/api/agents', headers });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [{ id: 'default', label: 'default', model: 'qwen3:8b', provider: 'ollama' }],
    });
  });

  it('lists the operator’s agents after the default', async () => {
    const { server, headers } = await start({
      provider: 'ollama',
      model: 'qwen3:8b',
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { label: 'Reviewer', model: 'qwen3:32b' } } },
      }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/agents', headers });

    expect(response.json()).toEqual({
      agents: [
        { id: 'default', label: 'default', model: 'qwen3:8b', provider: 'ollama' },
        { id: 'reviewer', label: 'Reviewer', model: 'qwen3:32b', provider: 'ollama' },
      ],
    });
  });

  it('omits a disabled agent', async () => {
    const { server, headers } = await start({
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { enabled: false } } },
      }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/agents', headers });
    expect(response.json<{ agents: { id: string }[] }>().agents.map((a) => a.id)).toEqual([
      'default',
    ]);
  });

  it('falls back to the id when an agent has no label', async () => {
    const { server, headers } = await start({
      config: ConfigSchema.parse({ agents: { list: { reviewer: {} } } }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/agents', headers });
    const agents = response.json<{ agents: { id: string; label: string }[] }>().agents;
    expect(agents.find((a) => a.id === 'reviewer')?.label).toBe('reviewer');
  });
});

describe('GET /api/status: the workspace', () => {
  it('reports an id and a count, never a host path', async () => {
    // `workspace: jail.root` used to be here — an absolute path handed to every
    // authenticated client, naming the operator's account and directory layout.
    // That is the one string that turns a blind traversal attempt into a
    // targeted one, so nothing absolute crosses this boundary any more.
    const { server, headers } = await start({});

    const response = await server.app.inject({ method: 'GET', url: '/api/status', headers });
    const body = response.json();

    expect(body.workspaceId).toBe('default');
    expect(body).not.toHaveProperty('workspace');
    for (const value of Object.values(body)) {
      if (typeof value === 'string') expect(value.startsWith('/')).toBe(false);
    }
  });
});
