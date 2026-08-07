/**
 * The command table, and the rule that decides what is one.
 *
 * The parser gets the most attention here, and it earns it. Telegram matches on
 * a `bot_command` entity so a message that merely mentions `/clear` is prose for
 * free; the browser has no entities, so the rule is a regex, and a regex that is
 * one character too generous sends `/usr/bin/env is on the path` to a dispatcher
 * instead of to the model.
 *
 * The table itself is exercised against a plain object rather than through the
 * UI, which is what `CommandContext` exists for: every guard is a branch, and
 * `packages/web` is gated at 85/80.
 */

import { describe, expect, it } from 'vitest';

import type { AgentSummary, ModelInfo } from '@ghostai/protocol';

import {
  commandRows,
  parseCommand,
  runCommand,
  type CommandContext,
  type CommandOutcome,
} from '@/chat/commands.js';

const AGENTS: readonly AgentSummary[] = [
  { id: 'default', label: 'Default', model: 'test-model', provider: 'ollama' },
];

const MODELS: readonly ModelInfo[] = [
  { id: 'test-model', providerId: 'ollama' },
];

/** Everything a command did, in the order it did it. */
interface Log {
  readonly calls: string[];
}

function context(
  overrides: Partial<CommandContext> = {},
): CommandContext & Log {
  const calls: string[] = [];
  return {
    calls,
    sessionKey: 'session-1',
    workspaceId: 'default',
    agentId: 'default',
    busy: false,
    stored: true,
    lastUserSeq: 7,
    agents: AGENTS,
    models: () => Promise.resolve(MODELS),
    newSession: () => {
      calls.push('newSession');
      return 'session-2';
    },
    openSession: (key) => calls.push(`open:${key}`),
    rename: (title) => {
      calls.push(`rename:${title}`);
      return Promise.resolve();
    },
    clear: () => {
      calls.push('clear');
      return Promise.resolve();
    },
    branch: (seq) => {
      calls.push(`branch:${String(seq)}`);
      return Promise.resolve('fork-1');
    },
    stop: () => calls.push('stop'),
    chooseAgent: (id) => {
      calls.push(`agent:${id}`);
      return Promise.resolve();
    },
    setModel: (model) => {
      // Both halves, because the pair is the setting.
      calls.push(`model:${model.providerId}/${model.id}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

async function run(text: string, ctx: CommandContext): Promise<CommandOutcome> {
  const parsed = parseCommand(text);
  if (parsed === undefined) throw new Error(`not a command: ${text}`);
  return await runCommand(parsed, ctx);
}

describe('deciding what is a command', () => {
  it('reads a name, its arguments and its tail', () => {
    expect(parseCommand('/rename  a long   title ')).toEqual({
      name: 'rename',
      args: ['a', 'long', 'title'],
      tail: 'a long   title',
    });
  });

  it.each([
    // The trap the whole rule exists for. A second slash in the first word is
    // what makes every path prose, however this table grows.
    '/usr/bin/env is on the path',
    '/etc/hosts',
    // A capital is the other half of it.
    '/Users/rezor/Code',
    // No slash at all, and a slash that is not leading.
    'clear the history',
    'try /clear next time',
    '',
    // Digits and dashes are not command names either.
    '/agent-2',
    '/404',
  ])('treats %j as prose', (text) => {
    expect(parseCommand(text)).toBeUndefined();
  });

  it('answers a name that fits the shape but matches nothing', async () => {
    // Not prose. Both other surfaces answer a mistyped command rather than
    // silently handing it to the model, and a browser that did would look
    // broken in exactly the way a typo is hardest to notice.
    expect(await run('/rname hello', context())).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.unknown',
      values: { name: 'rname' },
    });
  });
});

describe('the table', () => {
  it('describes every command with a key rather than with prose', () => {
    // The listing is what a person reads, so it is the half that gets
    // translated; the syntax beside it is what the parser matches on and is
    // never translated. Same split as `CommandRow` in the terminal.
    for (const command of commandRows()) {
      expect(command.name).toMatch(/^[a-z]+$/u);
      expect(command.description).toMatch(/^chat\.commands\./u);
    }
  });

  it('offers values only where there is a list to offer', () => {
    const withValues = commandRows()
      .filter((command) => command.values !== undefined)
      .map((command) => command.name);
    // A browser has no listing surface, so the two commands that take an id are
    // the two that must be able to complete it.
    expect(withValues).toEqual(['agent', 'model']);
  });
});

describe('/new', () => {
  it('mints a conversation and goes to it', async () => {
    const ctx = context();
    expect(await run('/new', ctx)).toEqual({
      kind: 'note',
      key: 'chat.commands.notes.started',
    });
    expect(ctx.calls).toEqual(['newSession', 'open:session-2']);
  });

  it('works before anything is stored, unlike the rest', async () => {
    // Nothing is persisted until the first message, so there is no row for the
    // `stored` guard to require.
    const ctx = context({ stored: false, sessionKey: undefined });
    expect((await run('/new', ctx)).kind).toBe('note');
  });
});

describe('/clear', () => {
  it('drops the history', async () => {
    const ctx = context();
    expect((await run('/clear', ctx)).kind).toBe('note');
    expect(ctx.calls).toEqual(['clear']);
  });

  it('refuses before the first message rather than earning a 404', async () => {
    const ctx = context({ stored: false });
    expect(await run('/clear', ctx)).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.nothingYet',
    });
    expect(ctx.calls).toEqual([]);
  });
});

describe('/rename', () => {
  it('takes the whole tail, spaces and all', async () => {
    const ctx = context();
    expect(await run('/rename The long title', ctx)).toEqual({
      kind: 'note',
      key: 'chat.commands.notes.renamed',
      values: { title: 'The long title' },
    });
    expect(ctx.calls).toEqual(['rename:The long title']);
  });

  it('says what it needs when given nothing', async () => {
    const ctx = context();
    expect(await run('/rename', ctx)).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.usageRename',
    });
    expect(ctx.calls).toEqual([]);
  });
});

describe('/stop', () => {
  it('aborts the turn that is running', async () => {
    const ctx = context({ busy: true });
    expect((await run('/stop', ctx)).kind).toBe('note');
    expect(ctx.calls).toEqual(['stop']);
  });

  it('says there is nothing to stop rather than sending a frame', async () => {
    const ctx = context({ busy: false });
    expect(await run('/stop', ctx)).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.notRunning',
    });
    expect(ctx.calls).toEqual([]);
  });
});

describe('/branch', () => {
  it('forks at the last thing you said, inclusively', async () => {
    // Unchanged, unlike the transcript's own Branch action, which passes
    // `seq - 1` so the message it sits under can be re-asked. This is the
    // terminal's reading, and the two differ by one on purpose.
    const ctx = context({ lastUserSeq: 7 });
    expect(await run('/branch', ctx)).toEqual({
      kind: 'note',
      key: 'chat.commands.notes.branched',
      values: { seq: 7 },
    });
    expect(ctx.calls).toEqual(['branch:7', 'open:fork-1']);
  });

  it('refuses when nothing has been said', async () => {
    const ctx = context({ lastUserSeq: undefined });
    expect(await run('/branch', ctx)).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.nothingToBranch',
    });
  });
});

describe('/agent', () => {
  it('moves the conversation', async () => {
    const ctx = context();
    expect(await run('/agent default', ctx)).toEqual({
      kind: 'note',
      key: 'chat.commands.notes.agentSet',
      values: { id: 'default' },
    });
    expect(ctx.calls).toEqual(['agent:default']);
  });

  it('refuses an id nothing offers', async () => {
    const ctx = context();
    expect(await run('/agent nope', ctx)).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.noAgent',
      values: { id: 'nope' },
    });
    expect(ctx.calls).toEqual([]);
  });

  it('says what it needs when given nothing', async () => {
    expect(await run('/agent', context())).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.usageAgent',
    });
  });

  it('offers every configured agent, labelled', () => {
    const values = commandRows().find((row) => row.name === 'agent')?.values;
    expect(values?.({ agents: AGENTS, models: MODELS })).toEqual([
      { value: 'default', hint: 'Default' },
    ]);
  });
});

describe('/model', () => {
  it('sets the install default', async () => {
    const ctx = context();
    expect(await run('/model test-model', ctx)).toEqual({
      kind: 'note',
      key: 'chat.commands.notes.modelSet',
      values: { id: 'test-model' },
    });
    expect(ctx.calls).toEqual(['model:ollama/test-model']);
  });

  it('asks for the catalogue rather than reading a field', async () => {
    // `/model x` typed straight past the completion list is the case a field
    // would get wrong: nothing has fetched the listing, so a field would be
    // empty and a model that exists would be refused.
    let asked = 0;
    const ctx = context({
      models: () => {
        asked += 1;
        return Promise.resolve(MODELS);
      },
    });
    await run('/model test-model', ctx);
    expect(asked).toBe(1);
  });

  it('refuses a model nothing offers', async () => {
    expect(await run('/model nope', context())).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.noModel',
      values: { id: 'nope' },
    });
  });

  it('says what it needs when given nothing', async () => {
    expect(await run('/model', context())).toEqual({
      kind: 'error',
      key: 'chat.commands.errors.usageModel',
    });
  });
});
