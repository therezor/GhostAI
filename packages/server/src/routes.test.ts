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
      workspace: expect.any(String),
      authEnabled: true,
      toolCount: 1,
      mcpServersConnected: 0,
      pluginsLoaded: 0,
    });
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
  it('describes every provider in the registry', async () => {
    const { server, headers } = await start({ credentialsPresent: { openai: true } });
    const response = await server.app.inject({ method: 'GET', url: '/api/providers', headers });

    const providers = response.json<ProvidersResponse>().providers;
    expect(providers).toHaveLength(PROVIDERS.length);
    expect(providers.find((provider) => provider.id === 'openai')).toMatchObject({
      displayName: 'OpenAI',
      wire: 'openai-chat',
      credentialsPresent: true,
    });
    expect(providers.find((provider) => provider.id === 'ollama')).toMatchObject({
      isLocal: true,
      credentialsPresent: false,
    });
  });
});

describe('GET /api/models', () => {
  it('lists what the settings name, plus the model in use', async () => {
    const { server, headers } = await start({
      provider: 'ollama',
      model: 'qwen3',
      config: ConfigSchema.parse({
        providers: { openai: { models: ['gpt-5', 'gpt-5-mini'] } },
      }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/models', headers });

    expect(response.json()).toEqual({
      // Sorted by provider then model, so a settings panel renders a stable
      // list rather than one that reorders when a model is added.
      models: [
        { id: 'qwen3', providerId: 'ollama' },
        { id: 'gpt-5', providerId: 'openai' },
        { id: 'gpt-5-mini', providerId: 'openai' },
      ],
      // Empty rather than one "not fetched" entry per provider: `errors` is for
      // a list that was attempted and failed.
      errors: {},
    });
  });

  it('prefers a runtime that can enumerate them', async () => {
    const { server, headers, runtime } = await start();
    Object.assign(runtime, {
      models: async () => ({
        models: [{ id: 'from-the-provider', providerId: 'openai' }],
        errors: { groq: 'connection refused' },
      }),
    });

    const response = await server.app.inject({ method: 'GET', url: '/api/models', headers });

    expect(response.json()).toEqual({
      models: [{ id: 'from-the-provider', providerId: 'openai' }],
      errors: { groq: 'connection refused' },
    });
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
