import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelsResponse } from '@ghostai/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { helpText, runSlashCommand, type SlashContext } from '#src/commands.js';
import { translations } from '#src/i18n.js';
import { NO_MENU, type Menu } from '#src/menu.js';
import type { ModelCatalogue } from '#src/models.js';
import { TurnRenderer } from '#src/render.js';
import { createChatRuntime, type ChatRuntime } from '#src/runtime.js';

const { t } = translations('en');
const help = helpText(t);
const lines = help.split('\n').filter((line) => line.trim().startsWith('/'));

describe('helpText', () => {
  it('lists every command a reader can type', () => {
    expect(help).toContain('/messages [n]');
    expect(help).toContain('/workspace move <from> <to>');
    expect(help).toContain('the last n messages, with their seq numbers');
  });

  it('groups the commands under headings', () => {
    for (const heading of [
      'sessions',
      'messages',
      'context and cost',
      'workspaces',
    ]) {
      expect(help).toContain(`\n  ${heading}\n`);
    }
  });

  it('aligns every description in one column', () => {
    // The bug this replaces: the column was a fixed number of spaces typed in
    // by hand, so it held only while every description was English — and the
    // first row was two characters out even then.
    const described = lines.filter((line) =>
      / {2,}\S/u.test(line.trimStart().slice(1)),
    );
    const columns = new Set(
      described.map((line) => line.search(/\S(?!.*\s\s)/u)),
    );

    expect(described.length).toBeGreaterThan(15);
    expect(columns.size).toBe(1);
  });

  it('indents every row the same, including the first', () => {
    expect(lines.every((line) => line.startsWith('  /'))).toBe(true);
  });

  it('renders the same syntax whatever the locale', () => {
    // `/rename` is what a user types, not a word describing it, so the left
    // column must survive translation untouched. Asserted against a locale that
    // does not exist, which falls back to English for the *descriptions* while
    // proving the syntax never went through `t` at all.
    const other = helpText(translations('zz').t);

    expect(other).toContain('/rename <title>');
    expect(other).toContain('/workspace move <from> <to>');
  });
});

/** A catalogue that dials nothing. Overridden by the tests that need models. */
function emptyCatalogue(models: ModelsResponse['models'] = []): ModelCatalogue {
  return {
    list: () => Promise.resolve({ models, errors: {} }),
    probe: () => Promise.resolve({ models: [] }),
    invalidate: () => {
      /* nothing is cached in a catalogue that dials nothing */
    },
  };
}

/**
 * A dispatcher context over a real runtime, recording what a command asked for.
 *
 * `NO_MENU` because there is no terminal here — which is the state every
 * scripted caller is in, so a command that would offer a picker has to fall
 * back on its own.
 */
function context(
  runtime: ChatRuntime,
  sessionKey: string,
  catalogue: ModelCatalogue = emptyCatalogue(),
): {
  readonly ctx: SlashContext;
  readonly chosen: string[];
  readonly agents: string[];
  readonly out: { text: string };
} {
  const chosen: string[] = [];
  const agents: string[] = [];
  const out = {
    text: '',
    write(chunk: string): boolean {
      out.text += chunk;
      return true;
    },
  };
  return {
    chosen,
    agents,
    out,
    ctx: {
      renderer: new TurnRenderer({ out }),
      runtime,
      t,
      locale: 'en',
      sessionKey,
      workspaceId: undefined,
      setWorkspace: (id) => chosen.push(id ?? 'default'),
      agentId: undefined,
      setAgent: (id) => agents.push(id ?? 'default'),
      menu: NO_MENU,
      models: catalogue,
      modelPinned: false,
    },
  };
}

describe('/workspace <id>', () => {
  const homes: string[] = [];

  function runtimeIn(): ChatRuntime {
    const home = mkdtempSync(join(tmpdir(), 'ghostai-slash-'));
    homes.push(home);
    mkdirSync(join(home, 'workspace'), { recursive: true });
    return createChatRuntime({ home });
  }

  afterEach(() => {
    while (homes.length > 0) {
      const dir = homes.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moves a conversation that exists', async () => {
    const runtime = runtimeIn();
    runtime.workspaces.create({ name: 'Research', id: 'research' });
    runtime.store.ensureSession('cli:1');

    const { ctx, chosen } = context(runtime, 'cli:1');
    await runSlashCommand('/workspace research', ctx);

    expect(chosen).toEqual(['research']);
    expect(runtime.store.getSession('cli:1')?.workspaceId).toBe('research');
  });

  it('does not mint a row for a session nobody has spoken in', async () => {
    // `updateSession` calls `ensureSession` internally, so patching an unspoken
    // conversation would create it — and an empty session would then show up in
    // every listing as though it were real.
    const runtime = runtimeIn();
    runtime.workspaces.create({ name: 'Research', id: 'research' });

    const { ctx, chosen } = context(runtime, 'cli:unspoken');
    await runSlashCommand('/workspace research', ctx);

    expect(chosen).toEqual(['research']);
    expect(runtime.store.getSession('cli:unspoken')).toBeUndefined();
  });

  it('refuses a workspace that does not exist, without moving anything', async () => {
    // Warned rather than thrown: a mistyped command must not end the REPL.
    const runtime = runtimeIn();
    runtime.store.ensureSession('cli:1');
    const { ctx, chosen, out } = context(runtime, 'cli:1');

    await runSlashCommand('/workspace nope', ctx);

    expect(out.text).toContain('nope');
    expect(chosen).toEqual([]);
    expect(runtime.store.getSession('cli:1')?.workspaceId).toBe('default');
  });
});

describe('/reasoning and /usage', () => {
  const homes: string[] = [];

  function runtimeIn(): ChatRuntime {
    const home = mkdtempSync(join(tmpdir(), 'ghostai-shown-'));
    homes.push(home);
    mkdirSync(join(home, 'workspace'), { recursive: true });
    return createChatRuntime({ home });
  }

  afterEach(() => {
    while (homes.length > 0) {
      const dir = homes.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flips reasoning off and back on with no argument', async () => {
    // No argument flips it, which is what a hand reaching for a switch expects.
    const { ctx, out } = context(runtimeIn(), 'cli:1');
    expect(ctx.renderer.reasoningShown).toBe(true);

    await runSlashCommand('/reasoning', ctx);
    expect(ctx.renderer.reasoningShown).toBe(false);
    expect(out.text).toContain('reasoning is hidden');

    await runSlashCommand('/reasoning', ctx);
    expect(ctx.renderer.reasoningShown).toBe(true);
    expect(out.text).toContain('reasoning is shown');
  });

  it('says it outright with on and off, for a hand that has lost track', async () => {
    const { ctx } = context(runtimeIn(), 'cli:1');

    await runSlashCommand('/reasoning off', ctx);
    await runSlashCommand('/reasoning off', ctx);
    expect(ctx.renderer.reasoningShown).toBe(false);

    await runSlashCommand('/reasoning on', ctx);
    await runSlashCommand('/reasoning on', ctx);
    expect(ctx.renderer.reasoningShown).toBe(true);
  });

  it('hides the tokens and timing after a turn', async () => {
    const { ctx, out } = context(runtimeIn(), 'cli:1');
    expect(ctx.renderer.usageShown).toBe(true);

    await runSlashCommand('/usage off', ctx);

    expect(ctx.renderer.usageShown).toBe(false);
    expect(out.text).toContain('tokens and timing are hidden');
  });

  it('treats a word it does not know as a flip rather than an error', async () => {
    const { ctx } = context(runtimeIn(), 'cli:1');
    await runSlashCommand('/usage yes-please', ctx);
    expect(ctx.renderer.usageShown).toBe(false);
  });
});

describe('/model', () => {
  const homes: string[] = [];

  function runtimeIn(): ChatRuntime {
    const home = mkdtempSync(join(tmpdir(), 'ghostai-model-'));
    homes.push(home);
    mkdirSync(join(home, 'workspace'), { recursive: true });
    return createChatRuntime({ home });
  }

  afterEach(() => {
    while (homes.length > 0) {
      const dir = homes.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  const MODELS = [
    { id: 'qwen3', providerId: 'ollama' },
    { id: 'llama3', providerId: 'ollama' },
  ];

  it('moves this run onto the named model', async () => {
    const runtime = runtimeIn();
    const { ctx, out } = context(runtime, 'cli:1', emptyCatalogue(MODELS));

    await runSlashCommand('/model qwen3', ctx);

    expect(runtime.model).toBe('qwen3');
    expect(out.text).toContain('this run now uses qwen3');
  });

  it('says the choice is not saved, because reconfigure is not a settings write', async () => {
    // `reconfigure` and `saveConfig` are deliberately separate operations. A
    // model chosen at a prompt lasts as long as the process, and the note is
    // what stops that being a surprise on the next launch.
    const runtime = runtimeIn();
    const { ctx, out } = context(runtime, 'cli:1', emptyCatalogue(MODELS));

    await runSlashCommand('/model qwen3', ctx);

    expect(out.text).toContain('settings panel is where a choice is saved');
    expect(existsSync(join(runtime.paths.root, 'config.json'))).toBe(false);
  });

  it('refuses under --model rather than appearing to work', async () => {
    const runtime = runtimeIn();
    const { ctx, out } = context(runtime, 'cli:1', emptyCatalogue(MODELS));

    await runSlashCommand('/model qwen3', { ...ctx, modelPinned: true });

    expect(out.text).toContain('--model pinned the model');
    expect(runtime.model).not.toBe('qwen3');
  });

  it('lists what the endpoints answered when there is no menu to open', async () => {
    const runtime = runtimeIn();
    const { ctx, out } = context(runtime, 'cli:1', emptyCatalogue(MODELS));

    await runSlashCommand('/model', ctx);

    expect(out.text).toContain('qwen3');
    expect(out.text).toContain('ollama');
  });

  it('says which endpoint went quiet rather than showing a shorter list', async () => {
    // A silently shorter list reads as "that model is gone" rather than "that
    // laptop is shut", and those send an operator to different places.
    const runtime = runtimeIn();
    const catalogue: ModelCatalogue = {
      list: () =>
        Promise.resolve({
          models: MODELS,
          errors: { openai: 'connect ECONNREFUSED' },
        }),
      probe: () => Promise.resolve({ models: [] }),
      invalidate: () => {
        /* nothing is cached in a catalogue that dials nothing */
      },
    };
    const { ctx, out } = context(runtime, 'cli:1', catalogue);

    await runSlashCommand('/model', ctx);

    expect(out.text).toContain('openai did not answer');
    expect(out.text).toContain('ECONNREFUSED');
  });

  it('says so when nothing published a list at all', async () => {
    const runtime = runtimeIn();
    const { ctx, out } = context(runtime, 'cli:1');

    await runSlashCommand('/model', ctx);

    expect(out.text).toContain('no endpoint published a model list');
  });
});

describe('/workspace with no argument', () => {
  const homes: string[] = [];

  function runtimeIn(): ChatRuntime {
    const home = mkdtempSync(join(tmpdir(), 'ghostai-wspick-'));
    homes.push(home);
    mkdirSync(join(home, 'workspace'), { recursive: true });
    return createChatRuntime({ home });
  }

  afterEach(() => {
    while (homes.length > 0) {
      const dir = homes.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A menu that answers with whatever it was told, without drawing anything. */
  function menuAnswering(value: string | undefined): Menu {
    return {
      available: true,
      choose: <T>(): Promise<T | undefined> =>
        Promise.resolve(value as T | undefined),
    };
  }

  it('switches to what the picker answered', async () => {
    const runtime = runtimeIn();
    runtime.workspaces.create({ name: 'Research', id: 'research' });
    runtime.store.ensureSession('cli:1');
    const { ctx, chosen } = context(runtime, 'cli:1');

    await runSlashCommand('/workspace', {
      ...ctx,
      menu: menuAnswering('research'),
    });

    expect(chosen).toEqual(['research']);
    expect(runtime.store.getSession('cli:1')?.workspaceId).toBe('research');
  });

  it('falls back to saying where sessions land when the picker was cancelled', async () => {
    const runtime = runtimeIn();
    const { ctx, chosen, out } = context(runtime, 'cli:1');

    await runSlashCommand('/workspace', {
      ...ctx,
      menu: menuAnswering(undefined),
    });

    expect(chosen).toEqual([]);
    expect(out.text).toContain('new sessions land in default');
  });

  it('says the same thing without a menu, so a pipe still gets an answer', async () => {
    const runtime = runtimeIn();
    const { ctx, out } = context(runtime, 'cli:1');

    await runSlashCommand('/workspace', ctx);

    expect(out.text).toContain('new sessions land in default');
  });
});

describe('/agent', () => {
  const homes: string[] = [];

  /** An install with two agents beside the default, which no install has by default. */
  function runtimeWithAgents(): ChatRuntime {
    const home = mkdtempSync(join(tmpdir(), 'ghostai-agents-'));
    homes.push(home);
    mkdirSync(join(home, 'workspace'), { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        agents: { list: { reviewer: { label: 'Reviewer' }, scout: {} } },
      }),
    );
    return createChatRuntime({ home });
  }

  afterEach(() => {
    while (homes.length > 0) {
      const dir = homes.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('moves a conversation that exists onto the named agent', async () => {
    const runtime = runtimeWithAgents();
    runtime.store.ensureSession('cli:1');
    const { ctx, agents, out } = context(runtime, 'cli:1');

    await runSlashCommand('/agent reviewer', ctx);

    expect(agents).toEqual(['reviewer']);
    expect(runtime.store.getSession('cli:1')?.agentId).toBe('reviewer');
    expect(out.text).toContain('now runs on reviewer');
  });

  it('records a preference, without minting a row, for a session nobody has spoken in', async () => {
    // The same guard `/workspace` needs and for the same reason: `updateSession`
    // calls `ensureSession` internally, so patching an unspoken conversation
    // would create it and put an empty session in every listing.
    const runtime = runtimeWithAgents();
    const { ctx, agents, out } = context(runtime, 'cli:unspoken');

    await runSlashCommand('/agent reviewer', ctx);

    expect(agents).toEqual(['reviewer']);
    expect(runtime.store.getSession('cli:unspoken')).toBeUndefined();
    expect(out.text).toContain('next session runs on reviewer');
  });

  it('refuses an agent that does not exist, without moving anything', async () => {
    const runtime = runtimeWithAgents();
    runtime.store.ensureSession('cli:1');
    const { ctx, agents, out } = context(runtime, 'cli:1');

    await runSlashCommand('/agent nope', ctx);

    expect(out.text).toContain('nope');
    expect(agents).toEqual([]);
    expect(runtime.store.getSession('cli:1')?.agentId).toBeUndefined();
  });

  it('lists them, marking the current one, when there is no menu to open', async () => {
    const runtime = runtimeWithAgents();
    runtime.store.ensureSession('cli:1');
    const { ctx, agents, out } = context(runtime, 'cli:1');
    await runSlashCommand('/agent reviewer', ctx);
    out.text = '';

    await runSlashCommand('/agent', ctx);

    expect(out.text).toContain('* reviewer');
    expect(out.text).toContain('  scout');
    // Listing is not choosing: nothing moved.
    expect(agents).toEqual(['reviewer']);
  });

  it('names an agent with no label of its own by its id', async () => {
    // `EffectiveAgent.label` is documented as never empty; `scout` has no label
    // in the config above, so this is the fallback doing its job.
    const runtime = runtimeWithAgents();
    const { ctx, out } = context(runtime, 'cli:1');

    await runSlashCommand('/agent', ctx);

    expect(out.text).toContain('scout  ·  scout');
  });
});
