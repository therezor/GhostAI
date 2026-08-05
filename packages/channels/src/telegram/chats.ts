/**
 * What the channel remembers about one Telegram chat.
 *
 * Deliberately small, and deliberately not persisted. The durable half of a
 * conversation is the session row in SQLite — the browser's sidebar lists the
 * same one — and everything here is either derivable from it or a rendering
 * preference that the terminal's own `/output` also loses on exit.
 *
 * The attachment is the interesting field. `ChannelManager` derives a session
 * from whatever key the channel publishes, so **switching conversation is just
 * publishing a different key**: `/new` and `/session` change this map and the
 * next message lands on a different hub connection, with the manager needing no
 * notion of a switch at all. That is the same thing the loopback channel's
 * `conversation` option does, one level up.
 *
 * Keys are stored already namespaced (`telegram:4471`). `ChannelManager`'s own
 * namespacing is idempotent once prefixed, so one form travels everywhere —
 * publish, control, and the store the commands read. Two forms in flight would
 * be a bug factory.
 */

/** Rendering preferences a chat owns, and the `/output` command toggles. */
export interface RenderPrefs {
  /**
   * Whether a turn is a message that fills in, or one final reply.
   *
   * Not the same field the terminal's `/output` carries. `reasoning` cannot be
   * expressed — the projection never emits a reasoning delta to any channel —
   * and `stats` has nothing to read; these two are what a chat transport
   * actually decides for itself.
   */
  progress: boolean;
  /** MarkdownV2, or plain text. The escape hatch when a message will not send. */
  markdown: boolean;
}

/** One chat's mutable state. */
export interface ChatState {
  /** The conversation this chat is attached to, already namespaced. */
  sessionKey: string;
  /** The message a running turn is being written into, if one is. */
  liveMessageId: number | undefined;
  /** The turn that message belongs to, so a stale edit is not applied. */
  liveTurnId: string | undefined;
  /** When that message was last edited, for the per-chat debounce. */
  lastEditMs: number;
  readonly prefs: RenderPrefs;
}

/** The default conversation for a chat: stable, so it survives a restart. */
export function defaultSessionKey(channelId: string, chatId: number): string {
  return `${channelId}:${String(chatId)}`;
}

/**
 * A fresh conversation in the same chat.
 *
 * A suffix rather than a wholly new key, so a glance at the session list still
 * says which chat a conversation came from.
 */
export function newSessionKey(
  channelId: string,
  chatId: number,
  unique: string,
): string {
  return `${defaultSessionKey(channelId, chatId)}:${unique}`;
}

/**
 * Whether a key names a conversation this channel owns.
 *
 * `/session <key>` is the one place an operator types a key by hand, and the
 * manager would happily namespace `web-abc` into `telegram:web-abc` — a real
 * conversation, empty, that nothing explains. Refusing is the difference
 * between an error and a mystery.
 */
export function ownsSessionKey(channelId: string, key: string): boolean {
  return key.startsWith(`${channelId}:`);
}

/** Every chat this channel has heard from since it started. */
export class ChatBook {
  private readonly channelId: string;
  private readonly states = new Map<number, ChatState>();

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  /** The chat's state, created on first sight and attached to its default. */
  for(chatId: number): ChatState {
    const existing = this.states.get(chatId);
    if (existing !== undefined) return existing;

    const created: ChatState = {
      sessionKey: defaultSessionKey(this.channelId, chatId),
      liveMessageId: undefined,
      liveTurnId: undefined,
      lastEditMs: 0,
      prefs: { progress: true, markdown: true },
    };
    this.states.set(chatId, created);
    return created;
  }

  /** Points a chat at another conversation. */
  attach(chatId: number, sessionKey: string): ChatState {
    const state = this.for(chatId);
    state.sessionKey = sessionKey;
    // The old turn's message belongs to the old conversation; editing it after
    // a switch would rewrite an answer the reader is still scrolled to.
    state.liveMessageId = undefined;
    state.liveTurnId = undefined;
    return state;
  }

  /** Back to the chat's own default. What `/exit` does. */
  detach(chatId: number): ChatState {
    return this.attach(chatId, defaultSessionKey(this.channelId, chatId));
  }

  /** Which chat is attached to a conversation, if any is. */
  chatFor(sessionKey: string): number | undefined {
    for (const [chatId, state] of this.states) {
      if (state.sessionKey === sessionKey) return chatId;
    }
    return undefined;
  }
}
