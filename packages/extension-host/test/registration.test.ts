import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ExtensionManifestSchema,
  type ExtensionContribution,
} from '@ghostwire/protocol';
import { defineTool, type AnyTool } from '@ghostwire/tools';

import { RegistrationBag, extensionToolName } from '#src/registration.js';

const manifest = (
  contributes: readonly ExtensionContribution[],
  id = 'slack',
): ReturnType<typeof ExtensionManifestSchema.parse> =>
  ExtensionManifestSchema.parse({
    schema: 'ghostai.extension/1',
    id,
    contributes,
  });

const tool = (name: string): AnyTool =>
  defineTool({
    name,
    description: 'Say hello.',
    risk: 'safe',
    schema: z.strictObject({ who: z.string() }),
    execute: (args) => `hello ${args.who}`,
  });

const factory = (id: string): { readonly id: string; create: () => never } => ({
  id,
  create: () => {
    throw new Error('not built here');
  },
});

const spec = (id: string): Parameters<RegistrationBag['addProvider']>[0] => ({
  id,
  displayName: id,
  wire: 'openai-chat',
  keywords: [],
});

describe('extensionToolName', () => {
  it('qualifies by extension, in the character class a provider accepts', () => {
    expect(extensionToolName('slack', 'post message')).toBe(
      'ext_slack_post-message',
    );
  });
});

describe('RegistrationBag: the namespace rule', () => {
  it('accepts the bare id and a hyphenated suffix', () => {
    const bag = new RegistrationBag(manifest(['channels', 'commands']));
    bag.addChannel(factory('slack'));
    bag.addChannel(factory('slack-dm'));
    bag.addCommand({ id: 'slack-post', run: () => ({ message: '' }) });

    const result = bag.result();
    expect(result.channels.map((one) => one.id)).toEqual(['slack', 'slack-dm']);
    expect(result.warnings).toEqual([]);
  });

  it('refuses an id that is not the extension’s, with a sentence', () => {
    // A channel id becomes a session-key prefix and a provider id becomes a
    // `providers.<id>.type`. Two extensions fighting over either is silent.
    const bag = new RegistrationBag(manifest(['channels', 'providers']));
    bag.addChannel(factory('telegram'));
    bag.addProvider(spec('openai'), undefined);

    const result = bag.result();
    expect(result.channels).toEqual([]);
    expect(result.providers).toEqual([]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/channel "telegram" is not namespaced/);
    expect(result.warnings[1]).toMatch(/provider "openai" is not namespaced/);
  });

  it('refuses a near-miss that merely starts with the id', () => {
    // `slackish` is a different extension's name, not a suffix of this one's.
    const bag = new RegistrationBag(manifest(['channels']));
    bag.addChannel(factory('slackish'));

    expect(bag.result().channels).toEqual([]);
  });

  it('rewrites a tool name rather than refusing it', () => {
    // Tool names have their own character class, so an extension writing
    // `post message` is asking a reasonable thing and the namespacer grants it.
    // A refusal would be pedantry.
    const bag = new RegistrationBag(manifest(['tools']));
    bag.addTool(tool('greet'));

    const registered = bag.result().tools[0];
    expect(registered?.name).toBe('ext_slack_greet');
    expect(bag.result().warnings).toEqual([]);
  });

  it('keeps the advertised definition in step with the registry key', () => {
    // The one place forgetting would produce a tool the model can see and
    // cannot call.
    const bag = new RegistrationBag(manifest(['tools']));
    bag.addTool(tool('greet'));
    const registered = bag.result().tools[0];

    expect(registered?.definition('extension').name).toBe('ext_slack_greet');
  });

  it('still runs the extension’s handler under the new name', async () => {
    // The rewrite copies a frozen object and re-binds four members. Asserting
    // the name alone would pass with `execute` pointing at nothing, which is a
    // tool the model can see, can call, and gets an error from.
    const bag = new RegistrationBag(manifest(['tools']));
    bag.addTool(tool('greet'));
    const registered = bag.result().tools[0];

    expect(registered?.parseArgs({ who: 'world' })).toEqual({
      ok: true,
      args: { who: 'world' },
    });
    // The string a handler returns, unwrapped: `run` normalises through
    // `toToolResult` only where the registry calls it.
    await expect(registered?.run({ who: 'world' }, {} as never)).resolves.toBe(
      'hello world',
    );
  });

  it('rejects bad arguments through the original schema', async () => {
    const bag = new RegistrationBag(manifest(['tools']));
    bag.addTool(tool('greet'));
    const registered = bag.result().tools[0];

    expect(registered?.parseArgs({ who: 1 })).toMatchObject({ ok: false });
    await expect(registered?.execute({ who: 'x' }, {} as never)).resolves.toBe(
      'hello x',
    );
  });

  it('leaves the extension’s own tool object untouched', () => {
    // `defineTool` freezes what it returns, and an extension may hand the same
    // object to two hosts in a test.
    const original = tool('greet');
    const bag = new RegistrationBag(manifest(['tools']));
    bag.addTool(original);

    expect(original.name).toBe('greet');
    expect(bag.result().tools[0]).not.toBe(original);
  });
});

describe('RegistrationBag: the contributes rule', () => {
  it('drops a kind the manifest never declared', () => {
    // Disclosure, not a security boundary: an operator who approved "commands"
    // is not surprised by a tool. The code could reach `node:fs` regardless.
    const bag = new RegistrationBag(manifest(['commands']));
    bag.addTool(tool('greet'));

    const result = bag.result();
    expect(result.tools).toEqual([]);
    expect(result.warnings[0]).toMatch(/Registered tools, which the manifest/);
  });

  it('names the fix in the warning', () => {
    const bag = new RegistrationBag(manifest([]));
    bag.addChannel(factory('slack'));

    expect(bag.result().warnings[0]).toMatch(
      /Add "channels" to it and re-approve/,
    );
  });

  it('drops each of the five independently', () => {
    const bag = new RegistrationBag(manifest([]));
    bag.addTool(tool('greet'));
    bag.addChannel(factory('slack'));
    bag.addProvider(spec('slack'), undefined);
    bag.addContributor({ name: 'slack' });
    bag.addCommand({ id: 'slack', run: () => ({ message: '' }) });

    const result = bag.result();
    expect(result).toMatchObject({
      tools: [],
      channels: [],
      providers: [],
      contributors: [],
      commands: [],
    });
    expect(result.warnings).toHaveLength(5);
  });

  it('keeps everything a manifest declares all five of', () => {
    const bag = new RegistrationBag(
      manifest(['tools', 'channels', 'providers', 'context', 'commands']),
    );
    bag.addTool(tool('greet'));
    bag.addChannel(factory('slack'));
    bag.addProvider(spec('slack-llm'), undefined);
    bag.addContributor({ name: 'slack' });
    bag.addCommand({ id: 'slack', run: () => ({ message: '' }) });

    const result = bag.result();
    expect(result.warnings).toEqual([]);
    expect(result.tools).toHaveLength(1);
    expect(result.channels).toHaveLength(1);
    expect(result.providers).toHaveLength(1);
    expect(result.contributors).toHaveLength(1);
    expect(result.commands).toHaveLength(1);
  });

  it('carries the wire adapter beside the spec it belongs to', () => {
    const wire = (): never => {
      throw new Error('not called');
    };
    const bag = new RegistrationBag(manifest(['providers']));
    bag.addProvider(spec('slack-llm'), wire);

    expect(bag.result().providers[0]?.wire).toBe(wire);
  });
});
