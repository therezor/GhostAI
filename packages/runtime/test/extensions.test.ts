/**
 * What the composition root does with an extension, and nothing about how one
 * is discovered or authorised — `packages/extension-host` owns that, and
 * `packages/security` owns the digest gate under it.
 *
 * The four things asserted here are the four seams this layer is responsible
 * for: an extension's tools reach the registry under the right source, its
 * prompt sections reach the loop, its provider types reach resolution, and none
 * of it survives a reconfigure any less well than MCP's registrations do.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Extension } from '@ghostbot/extension-host';
import { defineTool } from '@ghostbot/tools';

import {
  createRuntime,
  type GhostRuntime,
  type RuntimeOptions,
} from '#src/runtime.js';

const homes: string[] = [];
const opened: GhostRuntime[] = [];

function tempHome(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-ext-runtime-'));
  homes.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  }
  return dir;
}

/**
 * An install directory under a home's `extensions/`.
 *
 * The file behind `entry` is real but never imported: every runtime here is
 * built with a fake loader, which is the whole point of that seam.
 */
function install(
  home: string,
  id: string,
  contributes: readonly string[] = ['tools'],
): void {
  const dir = join(home, 'extensions', id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'ghostai.extension.json'),
    JSON.stringify({ schema: 'ghostai.extension/1', id, contributes }),
  );
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    'export const extension = {};\n',
  );
}

function build(options: RuntimeOptions = {}): GhostRuntime {
  const runtime = createRuntime({ vault: false, env: {}, ...options });
  opened.push(runtime);
  return runtime;
}

/** Builds a runtime, approves everything installed, and reloads. */
async function withExtension(
  home: string,
  extension: Extension,
  config: Record<string, unknown> = {},
): Promise<GhostRuntime> {
  const runtime = build({
    home,
    mcp: false,
    extensions: { load: () => Promise.resolve(extension) },
    ...config,
  });
  // `createRuntime` is synchronous and the first reconcile is detached, so the
  // approval below has to happen after it has settled or it would race.
  await runtime.reloadExtensions();
  for (const row of runtime.extensions?.status() ?? []) {
    approve(runtime, row.id);
  }
  await runtime.reloadExtensions();
  return runtime;
}

function approve(runtime: GhostRuntime, id: string): void {
  // Reaching the store through the same connection the runtime uses, which is
  // what `ghost extension approve` does through its own `ExtensionStore`.
  runtime.store.database
    .prepare(
      `INSERT INTO extension_approvals (id, digest, approved_at_ms)
       SELECT ?, ?, 0`,
    )
    .run(id, digestOf(runtime, id));
}

function digestOf(runtime: GhostRuntime, id: string): string {
  const row = runtime.extensions
    ?.status()
    .find((status) => status.id === id)?.digest;
  return row ?? '';
}

const greet = defineTool({
  name: 'greet',
  description: 'Say hello.',
  risk: 'safe',
  schema: z.strictObject({ who: z.string() }),
  execute: (args) => `hello ${args.who}`,
});

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('extensions in the composition root', () => {
  it('puts an extension’s tools in the shared registry, tagged as such', async () => {
    const home = tempHome({});
    install(home, 'slack');
    const runtime = await withExtension(home, {
      activate: (context) => {
        context.registerTool(greet);
      },
    });

    expect(runtime.tools.sourceOf('ext_slack_greet')).toBe('extension');
  });

  it('keeps them across a reconfigure, like MCP’s', async () => {
    // The reason `extensions` and `tools` are constructed outside `build`. A
    // settings save must not silently take a working extension's tools away.
    const home = tempHome({});
    install(home, 'slack');
    const runtime = await withExtension(home, {
      activate: (context) => {
        context.registerTool(greet);
      },
    });

    runtime.reconfigure({ agents: { defaults: { maxTokens: 4096 } } });

    expect(runtime.tools.sourceOf('ext_slack_greet')).toBe('extension');
  });

  it('takes an extension’s tools away when it is disabled', async () => {
    const home = tempHome({});
    install(home, 'slack');
    const runtime = await withExtension(home, {
      activate: (context) => {
        context.registerTool(greet);
      },
    });
    expect(runtime.tools.sourceOf('ext_slack_greet')).toBe('extension');

    runtime.reconfigure({ extensions: { disabled: ['slack'] } });
    await runtime.reloadExtensions();

    expect(runtime.tools.sourceOf('ext_slack_greet')).toBeUndefined();
  });

  it('leaves the built-ins alone when it removes an extension’s', async () => {
    // `unregisterBySource('extension')` would be the wrong grain twice over —
    // across sources and across extensions — which is why the sink remembers
    // names per id.
    const home = tempHome({});
    install(home, 'slack');
    const runtime = await withExtension(home, {
      activate: (context) => {
        context.registerTool(greet);
      },
    });

    runtime.reconfigure({ extensions: { disabled: ['slack'] } });
    await runtime.reloadExtensions();

    expect(runtime.tools.sourceOf('read_file')).toBe('builtin');
  });

  it('does not load anything an operator has not approved', async () => {
    const home = tempHome({});
    install(home, 'slack');
    const runtime = build({
      home,
      mcp: false,
      extensions: {
        load: () =>
          Promise.resolve({
            activate: (context) => {
              context.registerTool(greet);
            },
          }),
      },
    });
    await runtime.reloadExtensions();

    expect(runtime.extensions?.status()).toMatchObject([
      { id: 'slack', state: 'unapproved' },
    ]);
    expect(runtime.tools.sourceOf('ext_slack_greet')).toBeUndefined();
  });

  it('boots with no host at all when extensions are switched off', () => {
    const home = tempHome({});
    install(home, 'slack');
    const runtime = build({ home, mcp: false, extensions: false });

    expect(runtime.extensions).toBeUndefined();
    expect(runtime.tools.sourceOf('read_file')).toBe('builtin');
  });

  it('hands an extension its settings block from the config tree', async () => {
    const home = tempHome({
      extensions: { settings: { slack: { room: 'ops' } } },
    });
    install(home, 'slack');
    let seen: unknown;
    const runtime = await withExtension(home, {
      activate: (context) => {
        seen = context.settings;
      },
    });

    expect(seen).toEqual({ room: 'ops' });
    expect(runtime.extensions?.status()[0]?.state).toBe('ready');
  });

  it('resolves a provider type an extension contributed', async () => {
    // The half of the provider seam this layer owns: `createProvider` already
    // took a spec directly, but nothing could *configure* one until resolution
    // could see it.
    const home = tempHome({
      providers: { house: { type: 'slack-llm' } },
      agents: { defaults: { provider: 'house', model: 'corp-1' } },
    });
    install(home, 'slack', ['providers']);
    const runtime = await withExtension(home, {
      activate: (context) => {
        context.registerProvider({
          id: 'slack-llm',
          displayName: 'Slack LLM',
          wire: 'openai-chat',
          keywords: [],
          defaultApiBase: 'http://127.0.0.1:9/v1',
        });
      },
    });

    expect(runtime.extensions?.status()[0]?.providers).toEqual(['slack-llm']);
    // Resolution found the instance, which is the whole claim: without the
    // extension's spec in `specs`, `providers.house.type` names nothing and
    // `resolveInstance` answers null.
    expect(runtime.instance?.id).toBe('house');
    expect(runtime.instance?.spec.id).toBe('slack-llm');
  });

  it('adds an extension’s prompt section to the loop', async () => {
    const home = tempHome({
      agents: { defaults: { provider: 'ollama', model: 'qwen3:8b' } },
    });
    install(home, 'slack', ['context']);
    const runtime = await withExtension(home, {
      activate: (context) => {
        context.registerContributor({
          name: 'slack',
          staticSection: () => '## Slack\n\nThe #ops room is watched.',
        });
      },
    });

    expect(runtime.extensions?.contributors().map((one) => one.name)).toEqual([
      'slack',
    ]);
    expect(runtime.loop).not.toBeNull();
  });

  it('survives an extension that throws, and still builds a loop', async () => {
    const home = tempHome({
      agents: { defaults: { provider: 'ollama', model: 'qwen3:8b' } },
    });
    install(home, 'slack');
    const runtime = await withExtension(home, {
      activate: () => {
        throw new Error('no token');
      },
    });

    expect(runtime.extensions?.status()).toMatchObject([
      { id: 'slack', state: 'failed', lastError: 'no token' },
    ]);
    expect(runtime.loop).not.toBeNull();
  });
});
