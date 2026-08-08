import { afterEach, describe, expect, it } from 'vitest';

import { userMessage } from '@ghostbot/core';

import type { ChannelControlFrame } from '#src/channel.js';
import { ChatBook } from '#src/telegram/chats.js';
import {
  botCommands,
  helpText,
  parseCommand,
  resolveSeq,
  runCommand,
  type CommandInput,
} from '#src/telegram/commands.js';
import { CallbackStore } from '#src/telegram/menus.js';

import { fakeConsole, type FakeConsole } from './console-double.js';
import { manualClock } from './manual-clock.js';

const CHAT = 42;
const CHANNEL = 'telegram';

interface Harness {
  readonly console: FakeConsole;
  readonly book: ChatBook;
  readonly menus: CallbackStore;
  readonly frames: ChannelControlFrame[];
  run: (
    line: string,
    options?: { isAdmin?: boolean },
  ) => Promise<{ text: string; keyboard?: unknown }>;
  readonly sessionKey: () => string;
}

const consoles: FakeConsole[] = [];

function harness(): Harness {
  const shell = fakeConsole();
  consoles.push(shell);
  const book = new ChatBook(CHANNEL);
  const menus = new CallbackStore({ clock: manualClock() });
  const frames: ChannelControlFrame[] = [];
  let ids = 0;

  return {
    console: shell,
    book,
    menus,
    frames,
    sessionKey: () => book.for(CHAT).sessionKey,
    run: async (line, options = {}) => {
      const [word = '', ...args] = line.trim().split(/\s+/u);
      const input: CommandInput = {
        args,
        tail: line.trim().slice(word.length).trim(),
        chatId: CHAT,
        chat: book.for(CHAT),
        console: shell,
        menus,
        channelId: CHANNEL,
        isAdmin: options.isAdmin ?? true,
        control: (frame) => frames.push(frame),
        attach: (key) => book.attach(CHAT, key),
        newId: () => `id${String(++ids)}`,
      };
      return await runCommand(word.replace(/^\//u, ''), input);
    },
  };
}

afterEach(() => {
  while (consoles.length > 0) consoles.pop()?.close();
});

// ---------------------------------------------------------------------------

describe('parseCommand', () => {
  const entity = { type: 'bot_command', offset: 0 };

  it('reads a command and its arguments', () => {
    expect(
      parseCommand({ text: '/edit 12 new text', entities: [entity] }, 'bot'),
    ).toEqual({
      name: 'edit',
      args: ['12', 'new', 'text'],
      tail: '12 new text',
    });
  });

  it('ignores a slash in prose that Telegram did not mark', () => {
    // A message *about* /clear must not run it. Telegram already did the parse;
    // matching on the character would second-guess it wrongly.
    expect(
      parseCommand({ text: 'run /clear to reset' }, 'bot'),
    ).toBeUndefined();
    expect(parseCommand({ text: '/clear it' }, 'bot')).toBeUndefined();
  });

  it('strips the bot’s own username, which groups always attach', () => {
    expect(
      parseCommand(
        { text: '/sessions@ghost_bot', entities: [entity] },
        'ghost_bot',
      ),
    ).toMatchObject({ name: 'sessions' });
  });

  it('leaves a command addressed to another bot in the group alone', () => {
    expect(
      parseCommand(
        { text: '/sessions@other_bot', entities: [entity] },
        'ghost_bot',
      ),
    ).toBeUndefined();
  });

  it('lowercases the name, since phone keyboards capitalise', () => {
    expect(
      parseCommand({ text: '/Help', entities: [entity] }, 'bot'),
    ).toMatchObject({ name: 'help' });
  });
});

describe('resolveSeq', () => {
  it('counts a negative reference over your messages, not over rows', () => {
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key);
    h.console.store.append(key, userMessage('first'));
    h.console.store.append(key, {
      role: 'assistant',
      content: [{ type: 'text', text: 'an answer' }],
      toolCalls: [],
    });
    h.console.store.append(key, userMessage('second'));

    // -1 is the last thing *you* said, which is seq 3, not the assistant's 2.
    expect(resolveSeq(h.console.store, key, '-1')).toBe(3);
    expect(resolveSeq(h.console.store, key, '-2')).toBe(1);
  });

  it('defaults to your last message', () => {
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key);
    h.console.store.append(key, userMessage('only'));

    expect(resolveSeq(h.console.store, key, undefined)).toBe(1);
  });

  it('refuses a reference that is not a number', () => {
    const h = harness();
    expect(() => resolveSeq(h.console.store, h.sessionKey(), 'abc')).toThrow(
      /Not a message reference/u,
    );
  });

  it('refuses zero, which addresses nothing', () => {
    const h = harness();
    expect(() => resolveSeq(h.console.store, h.sessionKey(), '0')).toThrow(
      /Not a message reference/u,
    );
  });

  it('says so when you have not spoken yet', () => {
    const h = harness();
    expect(() => resolveSeq(h.console.store, h.sessionKey(), '-1')).toThrow(
      /not said anything/u,
    );
  });

  it('refuses a seq that is not in the conversation', () => {
    const h = harness();
    expect(() => resolveSeq(h.console.store, h.sessionKey(), '99')).toThrow(
      /No message 99/u,
    );
  });
});

// ---------------------------------------------------------------------------

describe('the command table', () => {
  it('registers every command with Telegram', () => {
    const names = botCommands().map((command) => command.command);

    expect(names).toContain('help');
    expect(names).toContain('sessions');
    expect(names).toContain('stop');
    // Telegram's own rule for a command name.
    for (const name of names) expect(name).toMatch(/^[a-z0-9_]{1,32}$/u);
  });

  it('keeps every description inside Telegram’s 256 characters', () => {
    for (const command of botCommands()) {
      expect(command.description.length).toBeLessThanOrEqual(256);
    }
  });

  it('hides an admin command from a non-admin’s /help', () => {
    expect(helpText(true)).toContain('/model');
    expect(helpText(false)).not.toContain('/model');
  });

  it('answers an unknown command rather than ignoring it', async () => {
    const h = harness();

    // Silence on a typo looks like a bot that has died.
    await expect(h.run('/nonsense')).resolves.toMatchObject({
      text: expect.stringContaining('/help') as unknown,
    });
  });
});

describe('sessions', () => {
  it('/new starts one and attaches to it', async () => {
    const h = harness();
    const before = h.sessionKey();

    const result = await h.run('/new Planning');

    expect(h.sessionKey()).not.toBe(before);
    expect(h.sessionKey().startsWith(`${CHANNEL}:${String(CHAT)}:`)).toBe(true);
    expect(h.console.store.getSession(h.sessionKey())?.title).toBe('Planning');
    expect(result.text).toContain('Planning');
  });

  it('/new records the channel as the session’s origin', async () => {
    const h = harness();
    await h.run('/new');

    expect(h.console.store.getSession(h.sessionKey())?.origin).toBe(CHANNEL);
  });

  it('/session with no key describes where you are', async () => {
    const h = harness();
    h.console.store.ensureSession(h.sessionKey(), { title: 'Here' });

    await expect(h.run('/session')).resolves.toMatchObject({
      text: expect.stringContaining('Here') as unknown,
    });
  });

  it('/session refuses a key belonging to another channel', async () => {
    // The manager would namespace `web-abc` into `telegram:web-abc` — a real,
    // empty conversation that nothing explains.
    const h = harness();

    const result = await h.run('/session web-abc');

    expect(result.text).toContain('another channel');
    expect(h.sessionKey()).not.toContain('web-abc');
  });

  it('/session attaches to one of ours', async () => {
    const h = harness();
    const target = `${CHANNEL}:${String(CHAT)}:other`;
    h.console.store.ensureSession(target);

    await h.run(`/session ${target}`);

    expect(h.sessionKey()).toBe(target);
  });

  it('/sessions offers only this channel’s sessions', async () => {
    const h = harness();
    h.console.store.ensureSession('telegram:42:a', {
      origin: 'telegram',
      title: 'Mine',
    });
    h.console.store.ensureSession('web:1', { origin: 'web', title: 'Theirs' });

    const result = await h.run('/sessions');

    expect(JSON.stringify(result.keyboard)).toContain('Mine');
    expect(JSON.stringify(result.keyboard)).not.toContain('Theirs');
  });

  it('/sessions says so when there are none', async () => {
    await expect(harness().run('/sessions')).resolves.toMatchObject({
      text: 'No sessions here yet.',
    });
  });

  it('/rename retitles', async () => {
    const h = harness();

    await h.run('/rename A better name');

    expect(h.console.store.getSession(h.sessionKey())?.title).toBe(
      'A better name',
    );
  });

  it('/rename with no title says how to use it', async () => {
    await expect(harness().run('/rename')).resolves.toMatchObject({
      text: expect.stringContaining('Usage') as unknown,
    });
  });

  it('/delete asks before it deletes', async () => {
    const h = harness();
    h.console.store.ensureSession(h.sessionKey(), { title: 'Doomed' });

    const result = await h.run('/delete');

    // Still there: the button is what deletes it.
    expect(h.console.store.getSession(h.sessionKey())).toBeDefined();
    expect(result.keyboard).toBeDefined();
    expect(result.text).toContain('cannot be undone');
  });

  it('/delete refuses a session that does not exist', async () => {
    await expect(
      harness().run('/delete telegram:42:ghost'),
    ).resolves.toMatchObject({
      text: expect.stringContaining('No session') as unknown,
    });
  });

  it('/clear empties the history and keeps the conversation', async () => {
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key);
    h.console.store.append(key, userMessage('something'));

    await h.run('/clear');

    expect(h.console.store.messageCount(key)).toBe(0);
    expect(h.console.store.getSession(key)).toBeDefined();
  });

  it('/branch forks and moves you to the fork', async () => {
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key, { origin: CHANNEL });
    h.console.store.append(key, userMessage('one'));
    h.console.store.append(key, userMessage('two'));

    await h.run('/branch -1');

    expect(h.sessionKey()).not.toBe(key);
    expect(h.console.store.getSession(h.sessionKey())).toBeDefined();
  });

  it('/exit detaches back to the chat’s own session', async () => {
    const h = harness();
    await h.run('/new');
    expect(h.sessionKey()).toContain(':id');

    await h.run('/exit');

    expect(h.sessionKey()).toBe(`${CHANNEL}:${String(CHAT)}`);
  });
});

describe('turns', () => {
  it('/stop sends the frame the browser’s Stop button sends', async () => {
    const h = harness();

    await h.run('/stop');

    expect(h.frames).toEqual([
      { type: 'turn.stop', sessionKey: h.sessionKey() },
    ]);
  });

  it('/edit rewrites and re-runs in one frame', async () => {
    // One frame, not a truncate plus a message: the two halves are a single
    // intent, and splitting them leaves a window for another client's queued
    // message to land in the gap.
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key);
    h.console.store.append(key, userMessage('the old question'));

    await h.run('/edit -1 the new question');

    expect(h.frames[0]).toEqual({
      type: 'user.edit',
      sessionKey: key,
      seq: 1,
      content: 'the new question',
      attachments: [],
    });
  });

  it('/edit without text says how to use it, and sends nothing', async () => {
    const h = harness();

    await expect(h.run('/edit 1')).resolves.toMatchObject({
      text: expect.stringContaining('Usage') as unknown,
    });
    expect(h.frames).toEqual([]);
  });

  it('/regenerate re-runs the last turn', async () => {
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key);
    h.console.store.append(key, userMessage('a question'));

    await h.run('/regenerate');

    expect(h.frames[0]).toEqual({
      type: 'turn.regenerate',
      sessionKey: key,
      seq: 1,
    });
  });

  it('/regenerate sends nothing when there is nothing to re-run', async () => {
    const h = harness();

    await expect(h.run('/regenerate')).resolves.toMatchObject({
      text: expect.stringContaining('not said anything') as unknown,
    });
    expect(h.frames).toEqual([]);
  });
});

describe('listings', () => {
  it('/messages prints the seq that /edit takes', async () => {
    const h = harness();
    const key = h.sessionKey();
    h.console.store.ensureSession(key);
    h.console.store.append(key, userMessage('hello there'));

    const result = await h.run('/messages');

    expect(result.text).toContain('`1`');
    expect(result.text).toContain('hello there');
  });

  it('/messages says so when nothing has been said', async () => {
    await expect(harness().run('/messages')).resolves.toMatchObject({
      text: 'Nothing said here yet.',
    });
  });

  it('/stats says so when no turn has run', async () => {
    await expect(harness().run('/stats')).resolves.toMatchObject({
      text: 'No turns recorded here yet.',
    });
  });

  it('/context reports the budget, not the transcript', async () => {
    const h = harness();
    h.console.setContext({
      sessionKey: h.sessionKey(),
      systemPrompt: 'a very long system prompt nobody wants in a chat',
      runtimeBlock: '',
      tools: [],
      messages: [],
      estimatedTokens: 4000,
      contextWindowTokens: 16_000,
      breakdown: { system: 1000, tools: 500, messages: 2500 },
      agentId: 'default',
    });

    const result = await h.run('/context');

    expect(result.text).toContain('4000 of 16000');
    expect(result.text).toContain('25%');
    expect(result.text).toContain('messages: 2500');
    // The prompt itself is thousands of lines nobody asked for.
    expect(result.text).not.toContain('nobody wants in a chat');
  });

  it('/context says so before there is anything to measure', async () => {
    await expect(harness().run('/context')).resolves.toMatchObject({
      text: 'Nothing to measure yet.',
    });
  });
});

describe('output preferences', () => {
  it('lists both fields when asked for neither', async () => {
    const result = await harness().run('/output');

    expect(result.text).toContain('progress: on');
    expect(result.text).toContain('markdown: on');
  });

  it('toggles a field when given no value', async () => {
    const h = harness();

    await h.run('/output markdown');

    expect(h.book.for(CHAT).prefs.markdown).toBe(false);
  });

  it('sets a field explicitly', async () => {
    const h = harness();

    await h.run('/output progress off');
    expect(h.book.for(CHAT).prefs.progress).toBe(false);
    await h.run('/output progress on');
    expect(h.book.for(CHAT).prefs.progress).toBe(true);
  });

  it('refuses a field this transport does not own', async () => {
    // `reasoning` is the terminal's, and no channel is ever sent one.
    await expect(harness().run('/output reasoning off')).resolves.toMatchObject(
      { text: expect.stringContaining('Usage') as unknown },
    );
  });
});

describe('agents and models', () => {
  it('/agent offers the ones this install has', async () => {
    const result = await harness().run('/agent');

    expect(JSON.stringify(result.keyboard)).toContain('Researcher');
  });

  it('/agent <id> binds the conversation', async () => {
    const h = harness();

    await h.run('/agent researcher');

    expect(h.console.store.getSession(h.sessionKey())?.agentId).toBe(
      'researcher',
    );
  });

  it('/agent refuses an id nobody has', async () => {
    await expect(harness().run('/agent nobody')).resolves.toMatchObject({
      text: expect.stringContaining('No agent') as unknown,
    });
  });

  it('/model is refused for a non-admin, because it moves the whole install', async () => {
    const h = harness();

    const result = await h.run('/model o3', { isAdmin: false });

    expect(result.text).toContain('administrator');
    expect(h.console.modelsSet).toEqual([]);
  });

  it('/model <id> moves the process for an admin', async () => {
    const h = harness();

    await h.run('/model o3', { isAdmin: true });

    expect(h.console.modelsSet).toEqual(['o3']);
  });

  it('/model with no id offers the catalogue', async () => {
    const result = await harness().run('/model');

    expect(JSON.stringify(result.keyboard)).toContain('gpt-4o');
  });
});

describe('workspaces', () => {
  it('/workspaces lists them, marking the one in use', async () => {
    const result = await harness().run('/workspaces');

    expect(result.text).toContain('`default`');
    expect(result.text).toContain('•');
  });

  it('/workspace with no argument offers a picker', async () => {
    const result = await harness().run('/workspace');

    expect(result.keyboard).toBeDefined();
  });

  it('/workspace <id> moves this conversation', async () => {
    const h = harness();
    h.console.workspaces.create({ name: 'Notes' });

    await h.run('/workspace notes');

    expect(h.console.store.getSession(h.sessionKey())?.workspaceId).toBe(
      'notes',
    );
  });

  it('/workspace refuses an id nobody has', async () => {
    await expect(harness().run('/workspace nowhere')).resolves.toMatchObject({
      text: expect.stringContaining('No workspace') as unknown,
    });
  });

  it('/workspace new creates one for an admin', async () => {
    const h = harness();

    await h.run('/workspace new Field notes', { isAdmin: true });

    expect(h.console.workspaces.list().map((w) => w.name)).toContain(
      'Field notes',
    );
  });

  it('/workspace new is refused for a non-admin', async () => {
    const h = harness();

    const result = await h.run('/workspace new Sneaky', { isAdmin: false });

    expect(result.text).toContain('administrator');
    expect(h.console.workspaces.list()).toHaveLength(1);
  });

  it('/workspace rm refuses one that still holds sessions', async () => {
    const h = harness();
    h.console.workspaces.create({ name: 'Notes' });
    h.console.store.ensureSession('telegram:42:x', { workspaceId: 'notes' });

    const result = await h.run('/workspace rm notes', { isAdmin: true });

    expect(result.text).toContain('still holds 1 sessions');
    expect(h.console.workspaces.get('notes')).toBeDefined();
  });

  it('/workspace move reassigns and reports how many', async () => {
    const h = harness();
    h.console.workspaces.create({ name: 'Notes' });
    h.console.store.ensureSession('telegram:42:x', { workspaceId: 'notes' });

    const result = await h.run('/workspace move notes default', {
      isAdmin: true,
    });

    expect(result.text).toContain('Moved 1 sessions');
  });

  it('/workspace rename renames for an admin', async () => {
    const h = harness();
    h.console.workspaces.create({ name: 'Notes' });

    await h.run('/workspace rename notes Field notes', { isAdmin: true });

    expect(h.console.workspaces.get('notes')?.name).toBe('Field notes');
  });

  it('names the usage for a verb given no arguments', async () => {
    await expect(
      harness().run('/workspace rename', { isAdmin: true }),
    ).resolves.toMatchObject({
      text: expect.stringContaining('Usage') as unknown,
    });
  });
});

describe('/memory', () => {
  it('says the tool is not granted when the agent lacks it', async () => {
    const h = harness();
    h.console.setMemory({ granted: false, count: 0, tokens: 0 });

    const result = await h.run('/memory');

    expect(result.text).toContain('does not have the `memory` tool');
  });

  it('reports an empty memory', async () => {
    const h = harness();
    const result = await h.run('/memory');
    expect(result.text).toContain('Nothing remembered yet');
  });

  it('reports how many there are and what the index costs', async () => {
    const h = harness();
    h.console.setMemory({ granted: true, count: 7, tokens: 420 });

    const result = await h.run('/memory');

    expect(result.text).toContain('7 memories');
    expect(result.text).toContain('420 tokens');
  });

  it('is offered to a non-admin, because it reaches only this chat', async () => {
    // Unlike `/model`, which moves the whole process.
    const h = harness();
    const result = await h.run('/memory', { isAdmin: false });
    expect(result.text).not.toContain('Only an admin');
  });
});

describe('/skills', () => {
  it('says the tool is not granted when the agent lacks it', async () => {
    const h = harness();
    h.console.setSkills({ granted: false, skills: [] });

    const result = await h.run('/skills');

    expect(result.text).toContain('does not have the `skill` tool');
  });

  it('says so when the workspace holds none', async () => {
    const h = harness();
    const result = await h.run('/skills');
    expect(result.text).toContain('No skills here yet');
  });

  it('lists each skill with its description', async () => {
    const h = harness();
    h.console.setSkills({
      granted: true,
      skills: [
        { name: 'deploy', description: 'Ship a release.' },
        { name: 'code-review', description: 'Review a diff.' },
      ],
    });

    const result = await h.run('/skills');

    expect(result.text).toContain('`deploy` — Ship a release.');
    expect(result.text).toContain('`code-review` — Review a diff.');
  });

  it('is offered to a non-admin, because it only reads', async () => {
    const h = harness();
    const result = await h.run('/skills', { isAdmin: false });
    expect(result.text).not.toContain('Only an admin');
  });
});

describe('/start', () => {
  it('answers rather than falling through to "no command"', async () => {
    // Telegram opens every first conversation with this, so until it existed
    // the first thing a new chat ever saw was an error.
    const h = harness();
    const result = await h.run('/start');

    expect(result.text).not.toContain('No command');
    expect(result.text).toContain('GhostAI');
  });

  it('carries the same listing as /help, rather than a second one', async () => {
    // Two lists disagree eventually, and the one that drifts is the one nobody
    // reads twice.
    const h = harness();
    const [start, help] = await Promise.all([h.run('/start'), h.run('/help')]);

    expect(start.text).toContain(help.text);
  });
});
