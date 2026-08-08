import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { silentLogger, systemClock } from '@ghostbot/core';
import type {
  ExtensionContribution,
  ExtensionsConfig,
} from '@ghostbot/protocol';
import { ExtensionsConfigSchema } from '@ghostbot/protocol';
import { ExtensionStore } from '@ghostbot/security';
import { defineTool } from '@ghostbot/tools';

import { ExtensionHost } from '#src/host.js';
import type { Extension, ExtensionContext } from '#src/extension.js';

let base: string;
let database: DatabaseSync;
let store: ExtensionStore;

const CONFIG = (patch: Partial<ExtensionsConfig> = {}): ExtensionsConfig =>
  ExtensionsConfigSchema.parse(patch);

/** An install directory. The code behind `entry` is never actually imported. */
function install(
  id: string,
  contributes: readonly ExtensionContribution[] = ['tools'],
): string {
  const dir = join(base, id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'ghostai.extension.json'),
    JSON.stringify({
      schema: 'ghostai.extension/1',
      id,
      version: '1.0.0',
      label: id,
      contributes,
    }),
  );
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    'export const extension = {};\n',
  );
  return dir;
}

const greetTool = (name = 'greet'): ReturnType<typeof defineTool> =>
  defineTool({
    name,
    description: 'Say hello.',
    risk: 'safe',
    schema: z.strictObject({ who: z.string() }),
    execute: (args) => `hello ${args.who}`,
  });

/** A host whose loader answers with whatever the test hands it. */
function hostFor(extensions: Readonly<Record<string, Extension>>): {
  readonly host: ExtensionHost;
  readonly load: ReturnType<typeof vi.fn>;
} {
  const load = vi.fn((entryPath: string) => {
    for (const [id, extension] of Object.entries(extensions)) {
      if (entryPath.includes(`/${id}/`)) return Promise.resolve(extension);
    }
    return Promise.reject(new Error(`no fake for ${entryPath}`));
  });
  const host = new ExtensionHost({
    store,
    dataDirFor: (id) => join(base, '..', 'extension-data', id),
    logger: silentLogger,
    clock: systemClock,
    load,
  });
  return { host, load };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-host-')));
  database = new DatabaseSync(':memory:');
  store = new ExtensionStore({ database, dir: base });
});

afterEach(() => {
  database.close();
  rmSync(base, { recursive: true, force: true });
});

describe('ExtensionHost.reconcile', () => {
  it('reports an unapproved extension rather than loading it', async () => {
    install('slack');
    const { host, load } = hostFor({});

    await host.reconcile(CONFIG());

    expect(host.status()).toMatchObject([{ id: 'slack', state: 'unapproved' }]);
    expect(host.status()[0]?.lastError).toMatch(/never been approved/);
    expect(load).not.toHaveBeenCalled();
    expect(host.loadedCount).toBe(0);
  });

  it('loads what an operator approved', async () => {
    install('slack');
    store.approve('slack');
    const activate = vi.fn((context: ExtensionContext) => {
      context.registerTool(greetTool());
    });
    const { host } = hostFor({ slack: { activate } });

    await host.reconcile(CONFIG());

    expect(host.status()).toMatchObject([{ id: 'slack', state: 'ready' }]);
    expect(host.loadedCount).toBe(1);
    expect(host.tools().map((tool) => tool.name)).toEqual(['ext_slack_greet']);
  });

  it('stops loading an extension whose files changed since approval', async () => {
    // The whole reason the digest covers the directory. Nobody has to remember
    // to re-approve, because they cannot avoid it.
    const dir = install('slack');
    store.approve('slack');
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          context.registerTool(greetTool());
        },
      },
    });

    await host.reconcile(CONFIG());
    expect(host.tools()).toHaveLength(1);

    writeFileSync(
      join(dir, 'dist', 'index.js'),
      'export const extension = 1;\n',
    );
    await host.reconcile(CONFIG());

    expect(host.status()).toMatchObject([{ id: 'slack', state: 'drifted' }]);
    expect(host.tools()).toEqual([]);
  });

  it('survives an extension that throws in activate', async () => {
    // The infallibility contract. A boot that refuses because one extension of
    // two is broken is worse than one that runs with the other.
    install('good');
    install('bad');
    store.approve('good');
    store.approve('bad');
    const { host } = hostFor({
      good: {
        activate: (context) => {
          context.registerTool(greetTool());
        },
      },
      bad: {
        activate: () => {
          throw new Error('no database connection');
        },
      },
    });

    await expect(host.reconcile(CONFIG())).resolves.toBeUndefined();

    expect(host.status()).toMatchObject([
      { id: 'bad', state: 'failed', lastError: 'no database connection' },
      { id: 'good', state: 'ready' },
    ]);
    expect(host.tools()).toHaveLength(1);
  });

  it('survives a module that will not import', async () => {
    install('slack');
    store.approve('slack');
    const { host } = hostFor({});

    await host.reconcile(CONFIG());

    expect(host.status()).toMatchObject([{ id: 'slack', state: 'failed' }]);
  });

  it('lists a disabled extension rather than forgetting it', async () => {
    // "Installed and off" and "not installed" are different things to see on a
    // panel, and the first is the one with a switch to flip.
    install('slack');
    store.approve('slack');
    const { host, load } = hostFor({ slack: { activate: () => undefined } });

    await host.reconcile(CONFIG({ disabled: ['slack'] }));

    expect(host.status()).toMatchObject([{ id: 'slack', state: 'disabled' }]);
    expect(load).not.toHaveBeenCalled();
  });

  it('leaves an unchanged extension running across a reconcile', async () => {
    // A reconcile happens on every settings save. Rebuilding a channel because
    // an unrelated panel was edited would drop connections for no reason.
    install('slack');
    store.approve('slack');
    const activate = vi.fn(() => undefined);
    const { host } = hostFor({ slack: { activate } });

    await host.reconcile(CONFIG());
    await host.reconcile(CONFIG());

    expect(activate).toHaveBeenCalledOnce();
  });

  it('unloads an extension that was uninstalled', async () => {
    const dir = install('slack');
    store.approve('slack');
    const deactivate = vi.fn(() => undefined);
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          context.registerTool(greetTool());
        },
        deactivate,
      },
    });

    await host.reconcile(CONFIG());
    rmSync(dir, { recursive: true, force: true });
    await host.reconcile(CONFIG());

    expect(host.status()).toEqual([]);
    expect(host.tools()).toEqual([]);
    expect(deactivate).toHaveBeenCalledOnce();
  });

  it('aborts an extension’s signal before asking it to deactivate', async () => {
    // Which is what lets an extension that only listens to the signal need no
    // `deactivate` at all.
    install('slack');
    store.approve('slack');
    let signal: AbortSignal | undefined;
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          signal = context.signal;
        },
        deactivate: () => {
          expect(signal?.aborted).toBe(true);
        },
      },
    });

    await host.reconcile(CONFIG());
    await host.stop();

    expect(signal?.aborted).toBe(true);
  });

  it('uninstalls an extension whose deactivate throws', async () => {
    // Otherwise a broken extension could not be removed, which is the one time
    // removal matters most.
    install('slack');
    store.approve('slack');
    const { host } = hostFor({
      slack: {
        activate: () => undefined,
        deactivate: () => {
          throw new Error('still writing');
        },
      },
    });

    await host.reconcile(CONFIG());
    await expect(host.stop()).resolves.toBeUndefined();

    expect(host.status()).toEqual([]);
  });

  it('hands an extension its own settings block', async () => {
    install('slack');
    store.approve('slack');
    let seen: unknown;
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          seen = context.settings;
        },
      },
    });

    await host.reconcile(
      CONFIG({ settings: { slack: { channel: '#ops' }, other: { a: 1 } } }),
    );

    expect(seen).toEqual({ channel: '#ops' });
  });

  it('gives an extension with no settings an empty block, never undefined', async () => {
    install('slack');
    store.approve('slack');
    let seen: unknown = 'untouched';
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          seen = context.settings;
        },
      },
    });

    await host.reconcile(CONFIG());

    expect(seen).toEqual({});
  });

  it('reads a secret from the vault rather than from the settings tree', async () => {
    install('slack');
    store.approve('slack');
    let seen: string | undefined;
    const host = new ExtensionHost({
      store,
      dataDirFor: (id) => join(base, id),
      secretFor: (id) => (id === 'slack' ? 'xoxb-token' : undefined),
      logger: silentLogger,
      clock: systemClock,
      load: () =>
        Promise.resolve({
          activate: (context: ExtensionContext) => {
            seen = context.secret();
          },
        }),
    });

    await host.reconcile(CONFIG());

    expect(seen).toBe('xoxb-token');
  });

  it('answers undefined for a secret when no vault was wired', async () => {
    install('slack');
    store.approve('slack');
    let seen: string | undefined = 'untouched';
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          seen = context.secret();
        },
      },
    });

    await host.reconcile(CONFIG());

    expect(seen).toBeUndefined();
  });
});

describe('ExtensionHost: what it collects', () => {
  it('gathers all five kinds, each behind its own accessor', async () => {
    // The composition root reads these five and puts each somewhere different —
    // a `ToolRegistry`, a `ChannelManager`, `resolveInstance`, an `AgentLoop`,
    // a route. Nothing here applies any of them.
    install('slack', ['tools', 'channels', 'providers', 'context', 'commands']);
    store.approve('slack');
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          context.registerTool(greetTool());
          context.registerChannel({
            id: 'slack',
            create: () => {
              throw new Error('not built here');
            },
          });
          context.registerProvider({
            id: 'slack-llm',
            displayName: 'Slack LLM',
            wire: 'openai-chat',
            keywords: [],
          });
          context.registerContributor({ name: 'slack' });
          context.registerCommand({
            id: 'slack',
            run: () => ({ message: 'ok' }),
          });
        },
      },
    });

    await host.reconcile(CONFIG());

    expect(host.tools().map((one) => one.name)).toEqual(['ext_slack_greet']);
    expect(host.channels().map((one) => one.id)).toEqual(['slack']);
    expect(host.providers().map((one) => one.spec.id)).toEqual(['slack-llm']);
    expect(host.contributors().map((one) => one.name)).toEqual(['slack']);
    expect(host.status()[0]).toMatchObject({
      state: 'ready',
      tools: ['ext_slack_greet'],
      channels: ['slack'],
      providers: ['slack-llm'],
      commands: ['slack'],
      warnings: [],
    });
  });

  it('reports what it dropped without refusing the rest', async () => {
    // An extension whose manifest declares one thing and whose code does two
    // installs the declared half and says so on its own row.
    install('slack', ['tools']);
    store.approve('slack');
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          context.registerTool(greetTool());
          context.registerChannel({
            id: 'slack',
            create: () => {
              throw new Error('not built here');
            },
          });
        },
      },
    });

    await host.reconcile(CONFIG());

    expect(host.tools()).toHaveLength(1);
    expect(host.channels()).toEqual([]);
    expect(host.status()[0]?.warnings[0]).toMatch(/Registered channels/);
    expect(host.status()[0]?.state).toBe('ready');
  });

  it('hands an extension a data directory outside its install', async () => {
    // Where the approval digest is not looking, which is the whole reason the
    // two are siblings.
    install('slack');
    store.approve('slack');
    let dataDir = '';
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          dataDir = context.dataDir;
        },
      },
    });

    await host.reconcile(CONFIG());

    expect(dataDir).toContain('extension-data');
    expect(dataDir.startsWith(join(base, 'slack'))).toBe(false);
  });
});

describe('ExtensionHost.subscribe', () => {
  it('fires on a load, because a channel-only extension moves no tool', async () => {
    install('slack');
    store.approve('slack');
    const { host } = hostFor({ slack: { activate: () => undefined } });
    const listener = vi.fn();
    host.subscribe(listener);

    await host.reconcile(CONFIG());

    expect(listener).toHaveBeenCalled();
    expect(host.revision).toBeGreaterThan(0);
  });

  it('stays quiet when a reconcile changes nothing', async () => {
    install('slack');
    store.approve('slack');
    const { host } = hostFor({ slack: { activate: () => undefined } });
    await host.reconcile(CONFIG());

    const listener = vi.fn();
    host.subscribe(listener);
    await host.reconcile(CONFIG());

    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ['unapproved', (): void => undefined],
    ['disabled', (): void => undefined],
  ])('stays quiet about an extension that is still %s', async (state) => {
    // A live-lock rather than a missed optimisation, and it took a real install
    // to find: announcing unconditionally woke the composition root, which
    // rebuilt, which reconciled again — and since the extension was still
    // unapproved, again, forever, on the thread everything else runs on. An
    // install with one unapproved extension stopped answering requests.
    install('slack');
    if (state === 'disabled') store.approve('slack');
    const config =
      state === 'disabled' ? CONFIG({ disabled: ['slack'] }) : CONFIG();
    const { host } = hostFor({ slack: { activate: () => undefined } });
    await host.reconcile(config);
    expect(host.status()).toMatchObject([{ state }]);

    const listener = vi.fn();
    host.subscribe(listener);
    await host.reconcile(config);
    await host.reconcile(config);

    expect(listener).not.toHaveBeenCalled();
  });

  it('stays quiet about an extension that already failed', async () => {
    // The same live-lock, one branch over, and the one the first fix missed:
    // a `failed` row has no registration, so the "already attempted" guard used
    // to skip it and re-activate on every reconcile — announcing every time.
    // Retrying cannot help anyway: Node's module registry hands back the module
    // it already holds, so the second `activate` is the first one again.
    install('slack');
    store.approve('slack');
    const activate = vi.fn(() => {
      throw new Error('no token');
    });
    const { host } = hostFor({ slack: { activate } });
    await host.reconcile(CONFIG());
    expect(host.status()).toMatchObject([{ state: 'failed' }]);

    const listener = vi.fn();
    host.subscribe(listener);
    await host.reconcile(CONFIG());
    await host.reconcile(CONFIG());

    expect(activate).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it('retries a failed extension once its files change', async () => {
    // Which is the whole reason the guard keys on the digest rather than on
    // "has it been tried": repairing it has to be enough.
    const dir = install('slack');
    store.approve('slack');
    let fail = true;
    const { host } = hostFor({
      slack: {
        activate: () => {
          if (fail) throw new Error('no token');
        },
      },
    });
    await host.reconcile(CONFIG());
    expect(host.status()).toMatchObject([{ state: 'failed' }]);

    fail = false;
    writeFileSync(join(dir, 'dist', 'index.js'), 'export const extension = 2;');
    store.approve('slack');
    await host.reconcile(CONFIG());

    expect(host.status()).toMatchObject([{ state: 'ready' }]);
  });

  it('reloads when an extension’s settings change', async () => {
    // An extension reads its settings once, in `activate`, so without this a
    // changed greeting would sit in `config.json` doing nothing until a
    // restart.
    install('slack');
    store.approve('slack');
    const seen: unknown[] = [];
    const { host } = hostFor({
      slack: {
        activate: (context) => {
          seen.push(context.settings);
        },
      },
    });

    await host.reconcile(CONFIG({ settings: { slack: { room: 'ops' } } }));
    await host.reconcile(CONFIG({ settings: { slack: { room: 'ops' } } }));
    await host.reconcile(CONFIG({ settings: { slack: { room: 'alerts' } } }));

    expect(seen).toEqual([{ room: 'ops' }, { room: 'alerts' }]);
  });

  it('announces when a refused extension’s reason changes', async () => {
    // The other half of it: quiet is only correct while nothing moved. An
    // unapproved extension whose files were edited has a new digest, and the
    // panel has to hear about it.
    const dir = install('slack');
    const { host } = hostFor({ slack: { activate: () => undefined } });
    await host.reconcile(CONFIG());

    const listener = vi.fn();
    host.subscribe(listener);
    writeFileSync(join(dir, 'dist', 'index.js'), 'export const extension = 2;');
    await host.reconcile(CONFIG());

    expect(listener).toHaveBeenCalledOnce();
  });

  it('stops calling a listener that unsubscribed', async () => {
    install('slack');
    store.approve('slack');
    const { host } = hostFor({ slack: { activate: () => undefined } });
    const listener = vi.fn();
    host.subscribe(listener)();

    await host.reconcile(CONFIG());

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ExtensionHost discovery', () => {
  it('skips a directory that could not be an extension', async () => {
    install('slack');
    mkdirSync(join(base, 'node_modules'), { recursive: true });
    const { host } = hostFor({});

    await host.reconcile(CONFIG());

    expect(host.status().map((row) => row.id)).toEqual(['slack']);
  });

  it('loads a path named in extensions.load', async () => {
    const elsewhere = realpathSync(
      mkdtempSync(join(tmpdir(), 'ghostai-load-')),
    );
    try {
      const dir = join(elsewhere, 'corp');
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(
        join(dir, 'ghostai.extension.json'),
        JSON.stringify({ schema: 'ghostai.extension/1', id: 'corp' }),
      );
      writeFileSync(
        join(dir, 'dist', 'index.js'),
        'export const extension={};',
      );

      const { host } = hostFor({});
      await host.reconcile(CONFIG({ load: [dir] }));

      expect(host.status()).toMatchObject([
        { id: 'corp', state: 'unapproved' },
      ]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores a load path that is not an extension directory', async () => {
    const { host } = hostFor({});

    await host.reconcile(CONFIG({ load: [join(base, 'nowhere')] }));

    expect(host.status()).toEqual([]);
  });
});

describe('ExtensionHost.runCommand', () => {
  const withCommand = (
    run: (input: { readonly args: string }) => { readonly message: string },
  ): Extension => ({
    activate: (context) => {
      context.registerCommand({
        id: 'slack-post',
        description: 'Post to Slack.',
        run,
      });
    },
  });

  it('lists a command with the extension that owns it', async () => {
    install('slack', ['commands']);
    store.approve('slack');
    const { host } = hostFor({
      slack: withCommand(() => ({ message: 'ok' })),
    });

    await host.reconcile(CONFIG());

    expect(host.commands()).toEqual([
      {
        id: 'slack-post',
        extensionId: 'slack',
        description: 'Post to Slack.',
        argsHint: '',
      },
    ]);
  });

  it('runs it and answers with text rather than a resource key', async () => {
    install('slack', ['commands']);
    store.approve('slack');
    const { host } = hostFor({
      slack: withCommand((input) => ({ message: `posted ${input.args}` })),
    });
    await host.reconcile(CONFIG());

    const result = await host.runCommand('slack-post', {
      args: 'hello',
      sessionKey: undefined,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ message: 'posted hello' });
  });

  it('turns a command that throws into a failed result, not a 500', async () => {
    install('slack', ['commands']);
    store.approve('slack');
    const { host } = hostFor({
      slack: withCommand(() => {
        throw new Error('Slack is down');
      }),
    });
    await host.reconcile(CONFIG());

    const result = await host.runCommand('slack-post', {
      args: '',
      sessionKey: undefined,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ message: 'Slack is down', ok: false });
  });

  it('refuses a command nobody registered', async () => {
    const { host } = hostFor({});

    await expect(
      host.runCommand('nope', {
        args: '',
        sessionKey: undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/No command called/);
  });
});
