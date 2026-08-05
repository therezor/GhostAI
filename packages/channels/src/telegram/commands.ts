/**
 * The terminal's slash commands, as bot commands.
 *
 * One table, three readers: `/help` renders it, `setMyCommands` registers it so
 * Telegram's own `/` menu lists it, and `run` dispatches on it. That is the
 * discipline `packages/cli/src/commands.ts` already holds with `commandRows()`,
 * and for the same reason: a second list beside this one eventually disagrees
 * with it, and the symptom is a command Telegram offers that does nothing.
 *
 * **Nothing here sends anything.** A command returns text, optionally a
 * keyboard, and the channel does the sending — so a command is a pure-ish
 * function over a store and can be tested without a transport. It is the same
 * split `SlashOutcome` makes in the terminal, where `/edit` hands content back
 * rather than running a turn itself.
 *
 * Three commands differ from their terminal spelling on purpose, and each says
 * why at its own definition: `/exit`, `/output` and the admin-gated verbs.
 */

import { GhostError, isGhostError, textOf } from '@ghostai/core';
import type { SessionStore } from '@ghostai/core';

import type { ChannelControlFrame } from '../channel.js';
import type { ChatState } from './chats.js';
import { newSessionKey, ownsSessionKey } from './chats.js';
import type { TelegramConsole } from './console.js';
import type { BotCommand, InlineKeyboardMarkup } from './api.js';
import {
  approvalKeyboard,
  confirmKeyboard,
  pickerKeyboard,
  type CallbackStore,
  type PickerRow,
} from './menus.js';

/** Rows `/messages` and `/stats` show when no count is given. */
const DEFAULT_LINES = 12;
/** How far back a negative message reference looks for what you said. */
const LOOKBACK = 400;
/** How much of a message body a listing shows before it stops. */
const CLIP = 90;

export interface CommandInput {
  /** Whitespace-split arguments, without the command word. */
  readonly args: readonly string[];
  /** Everything after the command word, untouched. `/rename` wants this. */
  readonly tail: string;
  readonly chatId: number;
  readonly chat: ChatState;
  readonly console: TelegramConsole;
  readonly menus: CallbackStore;
  readonly channelId: string;
  /** Whether this sender may run a command that reaches past their own chat. */
  readonly isAdmin: boolean;
  /** A frame on this chat's conversation. The channel supplies the envelope. */
  readonly control: (frame: ChannelControlFrame) => void;
  /** Points the chat at another conversation. */
  readonly attach: (sessionKey: string) => void;
  /** A fresh id, injected so a test is not at the mercy of a uuid. */
  readonly newId: () => string;
}

export interface CommandResult {
  readonly text: string;
  readonly keyboard?: InlineKeyboardMarkup;
}

export interface TelegramCommand {
  /** Telegram's own spelling: lowercase, no slash, no spaces. */
  readonly name: string;
  /** Extra words the parser reads, shown in `/help`. */
  readonly usage?: string;
  /** Registered with `setMyCommands`, so it must stay under 256 characters. */
  readonly description: string;
  /** Reaches past this chat, so a non-admin is refused at run time. */
  readonly admin?: boolean;
  /** Aliases that dispatch here. Not registered with Telegram. */
  readonly aliases?: readonly string[];
  run(input: CommandInput): Promise<CommandResult> | CommandResult;
}

// ---------------------------------------------------------------------------
// Reading arguments
// ---------------------------------------------------------------------------

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= CLIP ? flat : `${flat.slice(0, CLIP - 1)}…`;
}

/**
 * A message reference, as a `seq`.
 *
 * The terminal's rule, reimplemented rather than imported: it lives in
 * `packages/cli/src/messages.ts`, which this package cannot reach, and moving
 * it down into `@ghostai/core` would touch the CLI for no gain to the CLI.
 * Twenty lines is the cheaper of the two.
 *
 * A negative reference counts back over **user messages only** — `-1` is the
 * last thing you said, not the last row, because rows include assistant turns
 * and tool results and nobody counts backwards over a tool result.
 */
export function resolveSeq(
  store: SessionStore,
  sessionKey: string,
  ref: string | undefined,
): number {
  const trimmed = ref?.trim() ?? '';
  const raw = trimmed === '' ? -1 : Number(trimmed);

  if (!Number.isInteger(raw) || raw === 0) {
    throw new GhostError(
      'invalid_input',
      `Not a message reference: ${trimmed}. Use a seq from /messages, or -1 for your last message.`,
    );
  }

  if (raw > 0) {
    const [record] = store.messages(sessionKey, {
      afterSeq: raw - 1,
      beforeSeq: raw + 1,
    });
    if (record === undefined) {
      throw new GhostError(
        'not_found',
        `No message ${String(raw)} in this conversation.`,
      );
    }
    return raw;
  }

  const spoken = store
    .messages(sessionKey, { limit: LOOKBACK, fromEnd: true })
    .filter((record) => record.message.role === 'user');
  const record = spoken.at(raw);
  if (record === undefined) {
    throw new GhostError(
      'not_found',
      spoken.length === 0
        ? 'You have not said anything in this conversation yet.'
        : `Only ${String(spoken.length)} of your messages are in this conversation.`,
    );
  }
  return record.seq;
}

/** The conversations this channel owns, newest first. */
function ownSessions(
  input: CommandInput,
  limit: number,
): ReturnType<SessionStore['listSessions']> {
  // By origin rather than by key prefix: the hub records `channel` as the
  // session's origin (`hub.ts` → `loop.ts`), so this is an indexed column
  // rather than a scan with a `LIKE`.
  return input.console.store.listSessions({ origin: input.channelId, limit });
}

function titleOf(session: { title: string; key: string }): string {
  return session.title === '' ? session.key : session.title;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const COMMANDS: readonly TelegramCommand[] = [
  {
    name: 'help',
    description: 'Everything this bot understands',
    run: (input) => ({ text: helpText(input.isAdmin) }),
  },

  {
    name: 'messages',
    usage: '[n]',
    description: 'The last few messages, with the seq numbers /edit takes',
    run: (input) => {
      const count = positive(input.args[0], DEFAULT_LINES);
      const rows = input.console.store.messages(input.chat.sessionKey, {
        limit: count,
        fromEnd: true,
      });
      if (rows.length === 0) return { text: 'Nothing said here yet.' };
      return {
        text: rows
          .map(
            (row) =>
              `\`${String(row.seq)}\` ${row.message.role} — ${clip(textOf(row.message))}`,
          )
          .join('\n'),
      };
    },
  },

  {
    name: 'clear',
    description: 'Forget this conversation’s history, keeping the conversation',
    run: (input) => {
      input.console.store.clearMessages(input.chat.sessionKey);
      return { text: 'History cleared.' };
    },
  },

  {
    // Not "exit": there is no process to leave. Detaching is the analogous act
    // — the next message starts somewhere fresh — and it keeps the command in
    // Telegram's menu doing something rather than nothing.
    name: 'exit',
    aliases: ['quit'],
    description: 'Detach: the next message starts a fresh conversation',
    run: (input) => {
      input.menus.forget(input.chatId);
      input.attach(`${input.channelId}:${String(input.chatId)}`);
      return { text: 'Detached. The next message starts here again.' };
    },
  },

  {
    name: 'sessions',
    usage: '[n]',
    description: 'Pick a conversation',
    run: (input) => {
      const sessions = ownSessions(input, positive(input.args[0], 20));
      if (sessions.length === 0) return { text: 'No conversations here yet.' };

      const rows: PickerRow[] = sessions.map((session) => ({
        label: `${titleOf(session)} · ${String(session.messageCount)}`,
        ...(session.key === input.chat.sessionKey ? { current: true } : {}),
        payload: { kind: 'session', sessionKey: session.key },
      }));
      return {
        text: 'Which conversation?',
        keyboard: pickerKeyboard({
          rows,
          menu: 'sessions',
          chatId: input.chatId,
          store: input.menus,
        }),
      };
    },
  },

  {
    name: 'new',
    usage: '[title]',
    description: 'Start a fresh conversation',
    run: (input) => {
      const key = newSessionKey(input.channelId, input.chatId, input.newId());
      input.console.store.ensureSession(key, {
        origin: input.channelId,
        ...(input.tail === '' ? {} : { title: input.tail }),
      });
      input.attach(key);
      return {
        text:
          input.tail === ''
            ? 'Started a new conversation.'
            : `Started “${input.tail}”.`,
      };
    },
  },

  {
    name: 'session',
    usage: '[key]',
    description: 'Show this conversation, or attach to another by key',
    run: (input) => {
      const store = input.console.store;
      if (input.tail === '') {
        const session = store.getSession(input.chat.sessionKey);
        const count = store.messageCount(input.chat.sessionKey);
        return {
          text:
            `${session === undefined ? '(new)' : titleOf(session)}\n` +
            `\`${input.chat.sessionKey}\` · ${String(count)} messages · ` +
            `workspace ${session?.workspaceId ?? 'default'}`,
        };
      }

      // Refused rather than namespaced. `ChannelManager` would happily turn
      // `web-abc` into `telegram:web-abc` — a real, empty conversation that
      // nothing explains.
      if (!ownsSessionKey(input.channelId, input.tail)) {
        throw new GhostError(
          'invalid_input',
          'That conversation belongs to another channel. Use /sessions to pick one here.',
        );
      }
      input.attach(input.tail);
      return { text: `Attached to \`${input.tail}\`.` };
    },
  },

  {
    name: 'rename',
    usage: '<title>',
    description: 'Retitle this conversation',
    run: (input) => {
      if (input.tail === '') {
        throw new GhostError('invalid_input', 'Usage: /rename <title>');
      }
      input.console.store.ensureSession(input.chat.sessionKey, {
        origin: input.channelId,
      });
      input.console.store.updateSession(input.chat.sessionKey, {
        title: input.tail,
      });
      return { text: `Renamed to “${input.tail}”.` };
    },
  },

  {
    name: 'delete',
    usage: '[key]',
    description: 'Delete a conversation, after confirming',
    run: (input) => {
      const key = input.tail === '' ? input.chat.sessionKey : input.tail;
      if (!ownsSessionKey(input.channelId, key)) {
        throw new GhostError(
          'invalid_input',
          'That conversation belongs to another channel.',
        );
      }
      const session = input.console.store.getSession(key);
      if (session === undefined) {
        throw new GhostError('not_found', `No conversation \`${key}\`.`);
      }
      // A button rather than a second command, because this is the one thing
      // here that cannot be undone.
      return {
        text: `Delete “${titleOf(session)}”? This cannot be undone.`,
        keyboard: confirmKeyboard({
          chatId: input.chatId,
          store: input.menus,
          confirm: { kind: 'delete', sessionKey: key },
        }),
      };
    },
  },

  {
    name: 'branch',
    usage: '[ref]',
    description: 'Fork this conversation at a message and continue there',
    run: (input) => {
      const seq = resolveSeq(
        input.console.store,
        input.chat.sessionKey,
        input.args[0],
      );
      const fork = input.console.store.forkSession(input.chat.sessionKey, seq, {
        origin: input.channelId,
        key: newSessionKey(input.channelId, input.chatId, input.newId()),
      });
      input.attach(fork.session.key);
      return {
        text: `Branched at \`${String(fork.seq)}\`, carrying ${String(fork.copied)} messages.`,
      };
    },
  },

  {
    name: 'edit',
    usage: '<ref> <text>',
    description: 'Replace one of your messages and re-run from it',
    run: (input) => {
      const [ref, ...rest] = input.args;
      const content = rest.join(' ');
      if (ref === undefined || content === '') {
        throw new GhostError('invalid_input', 'Usage: /edit <ref> <text>');
      }
      const seq = resolveSeq(input.console.store, input.chat.sessionKey, ref);
      // Through the hub, not through the store: `user.edit` is one frame
      // because truncating and re-running are a single intent, and splitting
      // them leaves a window for another client's queued message.
      input.control({
        type: 'user.edit',
        sessionKey: input.chat.sessionKey,
        seq,
        content,
        attachments: [],
      });
      return { text: `Re-running from \`${String(seq)}\`.` };
    },
  },

  {
    name: 'regenerate',
    usage: '[ref]',
    description: 'Run a turn again, discarding the answer it gave',
    run: (input) => {
      const seq = resolveSeq(
        input.console.store,
        input.chat.sessionKey,
        input.args[0],
      );
      input.control({
        type: 'turn.regenerate',
        sessionKey: input.chat.sessionKey,
        seq,
      });
      return { text: `Re-running \`${String(seq)}\`.` };
    },
  },

  {
    // No terminal equivalent: Ctrl-C is the terminal's, and a chat has no
    // keystrokes. The frame is the same one the browser's Stop button sends.
    name: 'stop',
    description: 'Abort the turn that is running',
    run: (input) => {
      input.control({ type: 'turn.stop', sessionKey: input.chat.sessionKey });
      return { text: 'Stopping.' };
    },
  },

  {
    name: 'context',
    description: 'How much of the model’s window this conversation fills',
    run: async (input) => {
      const report = await input.console.context(input.chat.sessionKey);
      if (report === undefined) return { text: 'Nothing to measure yet.' };

      // The breakdown, not the transcript. A `ContextResponse` also carries the
      // whole system prompt, every tool definition and every stored message,
      // which in a chat app is thousands of lines nobody asked for.
      const rows = Object.entries(report.breakdown).map(
        ([name, tokens]) => `  ${name}: ${String(tokens)}`,
      );
      const percent =
        report.contextWindowTokens > 0
          ? Math.round(
              (report.estimatedTokens / report.contextWindowTokens) * 100,
            )
          : 0;
      return {
        text:
          `${String(report.estimatedTokens)} of ${String(report.contextWindowTokens)} tokens ` +
          `(${String(percent)}%), on agent \`${report.agentId ?? 'default'}\`\n` +
          rows.join('\n'),
      };
    },
  },

  {
    name: 'stats',
    usage: '[n]',
    description: 'What the last few turns cost',
    run: (input) => {
      const rows = input.console.store.turnStats(input.chat.sessionKey, {
        limit: positive(input.args[0], DEFAULT_LINES),
      });
      if (rows.length === 0) return { text: 'No turns recorded here yet.' };
      return {
        text: rows
          .map((row) => {
            const seconds = ((row.endedAtMs - row.startedAtMs) / 1000).toFixed(
              1,
            );
            return (
              `\`${row.model}\` · ${String(row.iterations)} steps · ` +
              `${String(row.usage.promptTokens)} in / ${String(row.usage.completionTokens)} out · ` +
              `${seconds}s · ${row.stopReason}`
            );
          })
          .join('\n'),
      };
    },
  },

  {
    // The terminal's two fields are `reasoning` and `stats`, and neither is
    // expressible here: the projection never emits a reasoning delta to any
    // channel, and nothing projects turn stats. `sendProgress` and
    // `sendToolHints` are the manager's, read once from the global config. So
    // the command keeps its shape and names the two things a chat owns.
    name: 'output',
    usage: '[progress|markdown] [on|off]',
    description: 'How answers are rendered in this chat',
    run: (input) => {
      const [field, value] = input.args;
      const prefs = input.chat.prefs;
      if (field === undefined) {
        return {
          text:
            `progress: ${prefs.progress ? 'on' : 'off'} — a turn fills in one message\n` +
            `markdown: ${prefs.markdown ? 'on' : 'off'} — formatted, or plain text`,
        };
      }
      if (field !== 'progress' && field !== 'markdown') {
        throw new GhostError(
          'invalid_input',
          'Usage: /output [progress|markdown] [on|off]',
        );
      }
      const next = value === undefined ? !prefs[field] : value === 'on';
      prefs[field] = next;
      return { text: `${field}: ${next ? 'on' : 'off'}` };
    },
  },

  {
    name: 'agent',
    usage: '[id]',
    description: 'Which agent this conversation runs on',
    run: (input) => {
      const agents = input.console.agents();
      const session = input.console.store.getSession(input.chat.sessionKey);
      if (input.tail === '') {
        return {
          text: 'Which agent?',
          keyboard: pickerKeyboard({
            rows: agents.map((agent) => ({
              label: `${agent.label} · ${agent.model}`,
              ...(agent.id === session?.agentId ? { current: true } : {}),
              payload: { kind: 'agent', agentId: agent.id },
            })),
            menu: 'agents',
            chatId: input.chatId,
            store: input.menus,
          }),
        };
      }
      if (!agents.some((agent) => agent.id === input.tail)) {
        throw new GhostError('not_found', `No agent \`${input.tail}\`.`);
      }
      input.console.store.ensureSession(input.chat.sessionKey, {
        origin: input.channelId,
      });
      input.console.store.updateSession(input.chat.sessionKey, {
        agentId: input.tail,
      });
      return { text: `This conversation now runs on \`${input.tail}\`.` };
    },
  },

  {
    // Admin, because it is not scoped to this chat: it moves the process, so
    // the browser and every other conversation move with it.
    name: 'model',
    usage: '[id]',
    description: 'Which model this install runs on (admin)',
    admin: true,
    run: async (input) => {
      const catalogue = await input.console.models();
      if (input.tail === '') {
        return {
          text: 'Which model?',
          keyboard: pickerKeyboard({
            rows: catalogue.models.map((model) => ({
              label: model.id,
              payload: { kind: 'model', modelId: model.id },
            })),
            menu: 'models',
            chatId: input.chatId,
            store: input.menus,
          }),
        };
      }
      input.console.setModel(input.tail);
      return { text: `Now running \`${input.tail}\`.` };
    },
  },

  {
    name: 'workspaces',
    description: 'The workspaces on this install',
    run: (input) => {
      const session = input.console.store.getSession(input.chat.sessionKey);
      const current = session?.workspaceId ?? 'default';
      return {
        text: input.console.workspaces
          .list()
          .map(
            (workspace) =>
              `${workspace.id === current ? '• ' : '  '}\`${workspace.id}\` — ${workspace.name}`,
          )
          .join('\n'),
      };
    },
  },

  {
    name: 'workspace',
    usage:
      '[id] | new <name> | rename <id> <name> | rm <id> | move <from> <to>',
    description: 'Move this conversation, or manage workspaces (verbs: admin)',
    run: (input) => runWorkspace(input),
  },
];

/** Everything dispatchable, aliases included. */
const BY_NAME = new Map<string, TelegramCommand>(
  COMMANDS.flatMap((command) => [
    [command.name, command] as const,
    ...(command.aliases ?? []).map((alias) => [alias, command] as const),
  ]),
);

// ---------------------------------------------------------------------------
// /workspace, which is four commands wearing one name
// ---------------------------------------------------------------------------

function requireAdmin(input: CommandInput, verb: string): void {
  if (input.isAdmin) return;
  throw new GhostError(
    'permission_denied',
    `\`/workspace ${verb}\` is for an administrator of this install.`,
  );
}

function runWorkspace(input: CommandInput): CommandResult {
  const [verb, ...rest] = input.args;
  const workspaces = input.console.workspaces;

  if (verb === undefined) {
    const session = input.console.store.getSession(input.chat.sessionKey);
    const current = session?.workspaceId ?? 'default';
    return {
      text: 'Which workspace should this conversation live in?',
      keyboard: pickerKeyboard({
        rows: workspaces.list().map((workspace) => ({
          label: workspace.name,
          ...(workspace.id === current ? { current: true } : {}),
          payload: { kind: 'workspace', workspaceId: workspace.id },
        })),
        menu: 'workspaces',
        chatId: input.chatId,
        store: input.menus,
      }),
    };
  }

  switch (verb) {
    case 'new': {
      requireAdmin(input, 'new');
      const name = rest.join(' ');
      if (name === '') {
        throw new GhostError('invalid_input', 'Usage: /workspace new <name>');
      }
      const created = workspaces.create({ name });
      return { text: `Created \`${created.id}\`.` };
    }

    case 'rename': {
      requireAdmin(input, 'rename');
      const [id, ...words] = rest;
      if (id === undefined || words.length === 0) {
        throw new GhostError(
          'invalid_input',
          'Usage: /workspace rename <id> <name>',
        );
      }
      workspaces.rename(id, words.join(' '));
      return { text: `Renamed \`${id}\`.` };
    }

    case 'rm': {
      requireAdmin(input, 'rm');
      const [id] = rest;
      if (id === undefined) {
        throw new GhostError('invalid_input', 'Usage: /workspace rm <id>');
      }
      const held = input.console.store.countByWorkspace(id);
      if (held > 0) {
        throw new GhostError(
          'invalid_input',
          `\`${id}\` still holds ${String(held)} conversations. Move them first with /workspace move.`,
        );
      }
      workspaces.delete(id);
      return { text: `Removed \`${id}\`.` };
    }

    case 'move': {
      requireAdmin(input, 'move');
      const [from, to] = rest;
      if (from === undefined || to === undefined) {
        throw new GhostError(
          'invalid_input',
          'Usage: /workspace move <from> <to>',
        );
      }
      const moved = input.console.store.reassignWorkspace(from, to);
      return { text: `Moved ${String(moved)} conversations to \`${to}\`.` };
    }

    default:
      // Not a verb, so it is an id — the same reading `commands.ts` gives it.
      return switchWorkspace(input, verb);
  }
}

function switchWorkspace(input: CommandInput, id: string): CommandResult {
  if (input.console.workspaces.get(id) === undefined) {
    throw new GhostError('not_found', `No workspace \`${id}\`.`);
  }
  input.console.store.ensureSession(input.chat.sessionKey, {
    origin: input.channelId,
  });
  input.console.store.updateSession(input.chat.sessionKey, {
    workspaceId: id,
  });
  return { text: `This conversation now lives in \`${id}\`.` };
}

// ---------------------------------------------------------------------------
// Parsing, dispatch and the two listings
// ---------------------------------------------------------------------------

export interface ParsedCommand {
  readonly name: string;
  readonly args: readonly string[];
  readonly tail: string;
}

/**
 * Reads a command out of a message, or decides it is not one.
 *
 * `entities` rather than a leading slash, because Telegram already did the
 * parse: a message that merely *mentions* `/clear` in prose carries no
 * `bot_command` entity at offset 0, and matching on the character would run it.
 *
 * In a group Telegram delivers `/sessions@ghost_bot`, so the bot's own username
 * is stripped — and a command addressed to a *different* bot in the same group
 * is not ours to answer.
 */
export function parseCommand(
  message: {
    readonly text?: string;
    readonly entities?: ReadonlyArray<{ type: string; offset: number }>;
  },
  botUsername: string | undefined,
): ParsedCommand | undefined {
  const text = message.text ?? '';
  const isCommand = (message.entities ?? []).some(
    (entity) => entity.type === 'bot_command' && entity.offset === 0,
  );
  if (!isCommand || !text.startsWith('/')) return undefined;

  const [word = '', ...args] = text.trim().split(/\s+/u);
  const [bare = '', addressed] = word.slice(1).split('@');
  if (
    addressed !== undefined &&
    botUsername !== undefined &&
    addressed.toLowerCase() !== botUsername.toLowerCase()
  ) {
    return undefined;
  }

  return {
    name: bare.toLowerCase(),
    args,
    tail: text.trim().slice(word.length).trim(),
  };
}

/**
 * Runs one command.
 *
 * Never throws for anything a person typed: a `GhostError` becomes the reply,
 * the way the terminal's dispatcher renders one as a warning and brings the
 * prompt back. An unknown command says so rather than being ignored, because a
 * bot that silently drops a typo looks broken.
 */
export async function runCommand(
  name: string,
  input: CommandInput,
): Promise<CommandResult> {
  const command = BY_NAME.get(name);
  if (command === undefined) {
    return { text: `No command \`/${name}\`. Try /help.` };
  }
  if (command.admin === true && !input.isAdmin) {
    return {
      text: `\`/${command.name}\` is for an administrator of this install.`,
    };
  }
  try {
    return await command.run(input);
  } catch (error) {
    if (isGhostError(error)) return { text: error.message };
    throw error;
  }
}

/** The list `setMyCommands` registers, so Telegram's own `/` menu has it. */
export function botCommands(): readonly BotCommand[] {
  return COMMANDS.map((command) => ({
    command: command.name,
    description: command.description,
  }));
}

/** `/help`, measured rather than typed out. */
export function helpText(isAdmin: boolean): string {
  const rows = COMMANDS.filter(
    (command) => command.admin !== true || isAdmin,
  ).map((command) => ({
    syntax: `/${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}`,
    description: command.description,
  }));

  return [
    'Send a message to talk to the agent. These are the commands:',
    '',
    ...rows.map((row) => `\`${row.syntax}\`\n   ${row.description}`),
  ].join('\n');
}

/** Re-exported so the channel builds an approval card without a second import. */
export { approvalKeyboard };
