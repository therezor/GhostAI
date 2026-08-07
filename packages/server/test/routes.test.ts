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
  type Config,
  type ProvidersResponse,
  type ToolDefinition,
} from '@ghostai/protocol';
import { GhostError } from '@ghostai/core';
import { PROVIDERS } from '@ghostai/providers';
import { afterEach, describe, expect, it } from 'vitest';

import { SERVER_VERSION } from '#src/version.js';
import { startTestServer, type TestServer } from '#testkit/server.js';
import type { GhostServer } from '#src/app.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start(
  ...args: Parameters<typeof startTestServer>
): Promise<TestServer> {
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

/** Registered on every install, seeded onto no agent. See the tools route. */
const AUTOMATION: ToolDefinition = {
  name: 'automation',
  description: 'Schedule work for later',
  parameters: { type: 'object', properties: {} },
  risk: 'exec',
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

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers,
    });

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
      extensionsLoaded: 0,
    });
  });

  it('reports a fresh install as unconfigured, without failing', async () => {
    // The whole point of the state: everything but a turn works, so the client
    // can render the app and point at setup rather than at an error page.
    const { server, headers } = await start({
      configured: false,
      provider: '',
      model: '',
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configured: false,
      provider: '',
      model: '',
    });
  });

  // The model is read through the runtime rather than snapshotted at boot, so a
  // settings save that moved it is visible here rather than only in the answer
  // that comes back from the wrong model.
  it('follows a settings save rather than the boot config', async () => {
    const { server, headers, runtime } = await start({ model: 'first' });

    const original = runtime.agent();
    Object.assign(runtime, { agent: () => ({ ...original, model: 'second' }) });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers,
    });

    expect(response.json().model).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
  it('returns the settings tree and presence flags', async () => {
    const { server, headers } = await start({
      credentialsPresent: { openai: true },
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });

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
      payload: {
        namespace: 'providers',
        key: 'openai',
        value: 'sk-the-actual-secret',
      },
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });

    expect(response.payload).not.toContain('sk-the-actual-secret');
    expect(response.json().credentialsPresent.openai).toBe(true);
    expect(runtime.credentialWrites).toEqual([
      { namespace: 'providers', key: 'openai', value: 'sk-the-actual-secret' },
    ]);
  });

  it('reports a config file that failed to parse', async () => {
    const { server, headers, runtime } = await start();
    Object.assign(runtime, {
      loadError: () => 'config.json is not valid JSON',
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });
    expect(response.json().loadError).toMatch(/not valid JSON/);
  });

  it('reports an empty warning list on a healthy install', async () => {
    // Empty rather than absent, so a client renders "nothing wrong" without a
    // presence check that would read a missing field as healthy too.
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });

    expect(response.json().warnings).toEqual([]);
  });

  it('carries settings that parsed but could not be honoured', async () => {
    const { server, headers, runtime } = await start();
    Object.assign(runtime, {
      configWarnings: () => [
        {
          code: 'missing_subagent',
          message: 'planner delegates to reviewer',
          agentId: 'planner',
        },
      ],
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });

    expect(response.json().warnings).toEqual([
      {
        code: 'missing_subagent',
        message: 'planner delegates to reviewer',
        agentId: 'planner',
      },
    ]);
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
    expect(runtime.patches).toEqual([
      { agents: { defaults: { temperature: 0.9 } } },
    ]);
  });

  it('serves the patched settings on the next read', async () => {
    const { server, headers } = await start();
    await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { agents: { defaults: { model: 'a-new-model' } } },
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });
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
    expect(Object.keys(response.json().error.details)).toEqual([
      '/agents/defaults/temperature',
    ]);
  });

  it('deletes an agent another one delegates to', async () => {
    // Used to be a 500 that changed nothing: the rebuild threw a `config` error
    // over the now-dangling delegation, and the rebuild happens before the
    // write, so the file was left exactly as it was.
    const { server, headers, runtime } = await start({
      config: ConfigSchema.parse({
        agents: {
          list: {
            reviewer: { label: 'Reviewer' },
            planner: {
              subagents: [{ id: 'reviewer', prompt: '', permission: 'allow' }],
            },
          },
        },
      }),
    });

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { agents: { list: { reviewer: null } } },
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.config().agents.list.reviewer).toBeUndefined();
  });

  it('forgets a deleted agent’s standing tool approvals', async () => {
    // An id is user-authored and re-creatable, so a new agent under a name the
    // operator just freed must not inherit what the old one was granted.
    const { server, headers, hub } = await start({
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { label: 'Reviewer' } } },
      }),
    });
    const retained: Array<ReadonlySet<string>> = [];
    const original = hub.retainAgents.bind(hub);
    Object.assign(hub, {
      retainAgents: (ids: ReadonlySet<string>) => {
        retained.push(ids);
        original(ids);
      },
    });

    await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { agents: { list: { reviewer: null } } },
    });

    expect(retained).toHaveLength(1);
    expect([...(retained[0] ?? [])]).toEqual(['default']);
  });
});

describe('POST /api/settings/reload', () => {
  it('re-reads the file and answers with what it is now serving', async () => {
    const edited = ConfigSchema.parse({
      agents: { defaults: { model: 'edited-by-hand' } },
    });
    const { server, headers, runtime } = await start({
      onReload: () => edited,
    });

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
    const edited = ConfigSchema.parse({
      agents: { defaults: { temperature: 0.9 } },
    });
    const { server, headers } = await start({ onReload: () => edited });
    await server.app.inject({
      method: 'POST',
      url: '/api/settings/reload',
      headers,
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });
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
    const settings = await server.app.inject({
      method: 'GET',
      url: '/api/settings',
      headers,
    });
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
    const { server, headers, runtime } = await start({
      credentialsPresent: { groq: true },
    });
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
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/providers',
      headers,
    });

    const { types } = response.json<ProvidersResponse>();
    expect(types).toHaveLength(PROVIDERS.length);
    expect(types.find((type) => type.id === 'openai')).toMatchObject({
      displayName: 'OpenAI',
      wire: 'openai-chat',
      supportsModelListing: true,
    });
    // The catalogue carries no credential flag: a credential belongs to a
    // configured endpoint, and two instances of one type can differ.
    expect(types.find((type) => type.id === 'openai')).not.toHaveProperty(
      'credentialsPresent',
    );
  });

  it('lists the configured instances, with a credential flag each', async () => {
    const { server, headers } = await start({
      credentialsPresent: { 'ollama-gpu': true },
      config: ConfigSchema.parse({
        providers: {
          ollama: { type: 'ollama' },
          'ollama-gpu': {
            type: 'ollama',
            label: 'GPU box',
            apiBase: 'http://gpu.lan:11434/v1',
          },
        },
      }),
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/providers',
      headers,
    });

    const { instances } = response.json<ProvidersResponse>();
    expect(instances.map((instance) => instance.id)).toEqual([
      'ollama',
      'ollama-gpu',
    ]);
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
        providers: {
          openai: { type: 'openai', models: ['gpt-5', 'gpt-5-mini'] },
        },
      }),
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/models',
      headers,
    });

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

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/models',
      headers,
    });

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
    const { server, headers } = await start({
      configured: false,
      provider: '',
      model: '',
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/models',
      headers,
    });
    expect(response.json()).toEqual({ models: [], errors: {} });
  });

  it('asks the runtime to bypass its cache on refresh', async () => {
    const { server, headers, runtime } = await start();
    const asked: Array<boolean | undefined> = [];
    Object.assign(runtime, {
      models: async (options?: { refresh?: boolean }) => {
        asked.push(options?.refresh);
        return { models: [], errors: {} };
      },
    });

    await server.app.inject({ method: 'GET', url: '/api/models', headers });
    await server.app.inject({
      method: 'POST',
      url: '/api/models/refresh',
      headers,
    });

    expect(asked).toEqual([false, true]);
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('GET /api/tools', () => {
  it('returns the live registry rather than the settings tree', async () => {
    const { server, headers } = await start({ tools: [READ_FILE] });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tools',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tools: [READ_FILE] });
  });

  /**
   * The one that matters, and the bug this route had: the only caller is the
   * agent editor, which draws a permission row per entry. Answering with the
   * default agent's *advertised* tools made a tool grantable only if the
   * default agent already held it — so `automation`, which no agent is seeded
   * with, had no row anywhere and could not be turned on from the UI at all.
   */
  it('offers a registered tool the default agent does not hold', async () => {
    const { server, headers } = await start({
      tools: [],
      registeredTools: [AUTOMATION],
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tools',
      headers,
    });

    expect(response.json()).toEqual({ tools: [AUTOMATION] });
  });

  it('answers with an empty list when nothing is registered', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/tools',
      headers,
    });

    expect(response.json()).toEqual({ tools: [] });
  });
});

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const READY_SERVER = {
  id: 'github',
  transport: 'streamableHttp' as const,
  state: 'ready' as const,
  enabled: true,
  tools: ['mcp_github_create-issue'],
  filteredTools: [],
  serverName: 'github-mcp',
  serverVersion: '1.2.0',
  warnings: [],
};

describe('GET /api/mcp', () => {
  it('reports live state the settings tree has nowhere to put', async () => {
    const failed = {
      ...READY_SERVER,
      id: 'linear',
      state: 'failed' as const,
      tools: [],
      lastError: 'ECONNREFUSED',
    };
    const { server, headers } = await start({
      mcpServers: [READY_SERVER, failed],
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/mcp',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ servers: [READY_SERVER, failed] });
  });

  it('answers with an empty list on a build that has no MCP client', async () => {
    // The port's method is optional, and an install without one has no MCP
    // servers — which is the question being asked, so it is a 200 and not a 501.
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/mcp',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ servers: [] });
  });

  it('counts only the servers a turn could reach on the status line', async () => {
    const { server, headers } = await start({
      mcpServers: [
        READY_SERVER,
        { ...READY_SERVER, id: 'linear', state: 'failed' as const },
        { ...READY_SERVER, id: 'notion', state: 'disabled' as const },
      ],
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers,
    });

    expect(response.json()).toMatchObject({ mcpServersConnected: 1 });
  });
});

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

describe('GET /api/agents', () => {
  it('lists the default agent on an install that named none', async () => {
    const { server, headers } = await start({
      provider: 'ollama',
      model: 'qwen3:8b',
    });
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/agents',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      agents: [
        {
          id: 'default',
          label: 'default',
          model: 'qwen3:8b',
          provider: 'ollama',
        },
      ],
    });
  });

  it('lists the operator’s agents after the default', async () => {
    const { server, headers } = await start({
      provider: 'ollama',
      model: 'qwen3:8b',
      config: ConfigSchema.parse({
        agents: {
          list: { reviewer: { label: 'Reviewer', model: 'qwen3:32b' } },
        },
      }),
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/agents',
      headers,
    });

    expect(response.json()).toEqual({
      agents: [
        {
          id: 'default',
          label: 'default',
          model: 'qwen3:8b',
          provider: 'ollama',
        },
        {
          id: 'reviewer',
          label: 'Reviewer',
          model: 'qwen3:32b',
          provider: 'ollama',
        },
      ],
    });
  });

  it('omits a disabled agent', async () => {
    const { server, headers } = await start({
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { enabled: false } } },
      }),
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/agents',
      headers,
    });
    expect(
      response
        .json<{ agents: Array<{ id: string }> }>()
        .agents.map((a) => a.id),
    ).toEqual(['default']);
  });
});

describe('renaming an agent through PATCH /api/settings', () => {
  /** A config with `reviewer`, and `planner` delegating to it. */
  function withReviewer(): Config {
    return ConfigSchema.parse({
      agents: {
        list: {
          reviewer: { label: 'Reviewer' },
          planner: {
            label: 'Planner',
            subagents: [
              { id: 'reviewer', prompt: 'Check it.', permission: 'allow' },
            ],
          },
        },
      },
    });
  }

  /**
   * A rename, as it travels: on the settings patch rather than its own route.
   *
   * `patch` is what an editor would send alongside it — the point of carrying
   * the two together is that a Save which changes an id *and* a setting is one
   * write, not two with a window between them.
   */
  function rename(
    server: GhostServer,
    from: string,
    to: string,
    headers: Record<string, string>,
    patch: Record<string, unknown> = {},
  ) {
    return server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: { ...patch, renameAgents: [{ from, to }] },
    });
  }

  it('moves the agent, its delegations and its conversations together', async () => {
    const { server, runtime, headers } = await start({
      config: withReviewer(),
    });
    runtime.store.ensureSession('mine', { agentId: 'reviewer' });
    runtime.store.ensureSession('other', { agentId: 'planner' });

    const response = await rename(server, 'reviewer', 'code-review', headers);

    expect(response.statusCode).toBe(200);

    const config = runtime.config();
    expect(config.agents.list.reviewer).toBeUndefined();
    expect(config.agents.list['code-review']?.label).toBe('Reviewer');
    // The delegation follows, so the model keeps the subagent it had.
    expect(config.agents.list.planner?.subagents.map((ref) => ref.id)).toEqual([
      'code-review',
    ]);
    // Conversations follow; ones bound elsewhere do not.
    expect(runtime.store.getSession('mine')?.agentId).toBe('code-review');
    expect(runtime.store.getSession('other')?.agentId).toBe('planner');
  });

  it('does not rewrite which agent ran a past turn', async () => {
    // History is a record of what happened, not a pointer to what exists now.
    const { server, runtime, headers } = await start({
      config: withReviewer(),
    });
    runtime.store.ensureSession('mine', { agentId: 'reviewer' });
    runtime.store.recordTurnStats({
      turnId: 't1',
      sessionKey: 'mine',
      agentId: 'reviewer',
      workspaceId: 'default',
      provider: 'ollama',
      model: 'qwen3:8b',
      startedAtMs: 1,
      endedAtMs: 2,
      iterations: 1,
      stopReason: 'complete',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await rename(server, 'reviewer', 'code-review', headers);

    expect(runtime.store.turnStats('mine')[0]?.agentId).toBe('reviewer');
  });

  it('answers a rename to the same id without complaining about it', async () => {
    const { server, runtime, headers } = await start({
      config: withReviewer(),
    });

    const response = await rename(server, 'reviewer', 'reviewer', headers);

    expect(response.statusCode).toBe(200);
    expect(runtime.config().agents.list.reviewer).toBeDefined();
  });

  it('404s for an agent that does not exist', async () => {
    const { server, headers } = await start({ config: withReviewer() });

    expect((await rename(server, 'ghost', 'phantom', headers)).statusCode).toBe(
      404,
    );
  });

  it('refuses to rename the default agent', async () => {
    // It resolves whether or not it has an entry, and an install with no
    // default agent is not a state anything downstream can use.
    const { server, headers } = await start({ config: withReviewer() });

    expect((await rename(server, 'default', 'house', headers)).statusCode).toBe(
      422,
    );
  });

  it.each([
    ['default', 'the reserved default'],
    ['con', 'a reserved device name'],
    ['../evil', 'a path traversal'],
    ['Reviewer', 'an upper-case letter'],
    ['-lead', 'a leading hyphen'],
    ['', 'empty'],
  ])('422s renaming to %s (%s)', async (to) => {
    const { server, headers } = await start({ config: withReviewer() });

    expect((await rename(server, 'reviewer', to, headers)).statusCode).toBe(
      422,
    );
  });

  it('409s when the new id is already taken', async () => {
    const { server, headers } = await start({ config: withReviewer() });

    const response = await rename(server, 'reviewer', 'planner', headers);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toMatch(/already an agent/);
  });

  it('carries the rename and the entry edit in one write', async () => {
    // The reason the two travel together. As separate requests this was two
    // writes with a window between them, and the failure mode was an agent
    // under its new name holding its old settings.
    const { server, runtime, headers } = await start({
      config: withReviewer(),
    });
    runtime.store.ensureSession('mine', { agentId: 'reviewer' });

    const response = await rename(server, 'reviewer', 'code-review', headers, {
      agents: {
        list: {
          'code-review': { label: 'Second Opinion', model: 'qwen3:32b' },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    // One `applySettings`, not two: the rename and the edit are one merge.
    expect(runtime.patches).toHaveLength(1);
    expect(runtime.config().agents.list['code-review']).toMatchObject({
      label: 'Second Opinion',
      model: 'qwen3:32b',
    });
    expect(runtime.store.getSession('mine')?.agentId).toBe('code-review');
  });

  it('changes nothing at all when the rename is refused', async () => {
    // Validated before `applySettings`, so a body carrying both a bad rename and
    // a good edit lands neither — which is what "atomic" has to mean from the
    // caller's side.
    const { server, runtime, headers } = await start({
      config: withReviewer(),
    });
    runtime.store.ensureSession('mine', { agentId: 'reviewer' });

    const response = await rename(server, 'reviewer', 'planner', headers, {
      agents: { list: { planner: { label: 'Renamed anyway' } } },
    });

    expect(response.statusCode).toBe(409);
    expect(runtime.patches).toEqual([]);
    expect(runtime.config().agents.list.reviewer).toBeDefined();
    expect(runtime.config().agents.list.planner?.label).toBe('Planner');
    expect(runtime.store.getSession('mine')?.agentId).toBe('reviewer');
  });

  it('moves two agents in one save', async () => {
    const { server, runtime, headers } = await start({
      config: withReviewer(),
    });
    runtime.store.ensureSession('one', { agentId: 'reviewer' });
    runtime.store.ensureSession('two', { agentId: 'planner' });

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers,
      payload: {
        renameAgents: [
          { from: 'reviewer', to: 'code-review' },
          { from: 'planner', to: 'strategist' },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    const list = runtime.config().agents.list;
    expect(list['code-review']).toBeDefined();
    expect(list.strategist).toBeDefined();
    // The delegation followed the agent it names, through both moves.
    expect(list.strategist?.subagents.map((ref) => ref.id)).toEqual([
      'code-review',
    ]);
    expect(runtime.store.getSession('one')?.agentId).toBe('code-review');
    expect(runtime.store.getSession('two')?.agentId).toBe('strategist');
  });

  it('renames an agent that is switched off', async () => {
    // Disabling is the reversible half of deleting, so a disabled agent is
    // still an agent — it is just absent from every listing.
    const { server, runtime, headers } = await start({
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { label: 'Reviewer', enabled: false } } },
      }),
    });

    const response = await rename(server, 'reviewer', 'code-review', headers);

    expect(response.statusCode).toBe(200);
    expect(runtime.config().agents.list['code-review']?.enabled).toBe(false);
  });

  it('falls back to the id when an agent has no label', async () => {
    const { server, headers } = await start({
      config: ConfigSchema.parse({ agents: { list: { reviewer: {} } } }),
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/agents',
      headers,
    });
    const agents = response.json<{
      agents: Array<{ id: string; label: string }>;
    }>().agents;
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

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/status',
      headers,
    });
    const body = response.json();

    expect(body.workspaceId).toBe('default');
    expect(body).not.toHaveProperty('workspace');
    for (const value of Object.values(body)) {
      if (typeof value === 'string') expect(value.startsWith('/')).toBe(false);
    }
  });
});
