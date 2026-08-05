/**
 * What the chat commands need that no hub frame expresses.
 *
 * The commands split cleanly in two, and the split is the reason there are two
 * seams rather than one. Anything that *starts, stops or rewrites a turn* —
 * `/stop`, `/edit`, `/regenerate`, an approval — goes through
 * `ChannelContext.control` and out the same door a browser uses, so it inherits
 * the busy check, the FIFO queue and the `session.truncated` broadcast that
 * tells an open tab its transcript was rewritten. Everything else is a read or
 * a write against stores the hub has no frame for: listing conversations,
 * renaming one, measuring a context window, naming an agent.
 *
 * This is that second half, and it is a **factory option rather than a
 * `ChannelContext` member** on purpose. `channel.ts` states that a channel
 * never sees a session store; putting one on the context would hand it to every
 * plugin channel that is ever registered. The composition root compiles this
 * channel in and hands it a store deliberately, which is a different act.
 *
 * Typed entirely in `@ghostai/core` and `@ghostai/protocol` vocabulary, because
 * that is the whole of what this package may import — and because it happens to
 * be the same vocabulary the REST API answers in, so `serve.ts` satisfies most
 * of it with what `ServerRuntime` already exposes.
 */

import type { SessionStore, WorkspaceStore } from '@ghostai/core';
import type {
  AgentSummary,
  ContextResponse,
  ModelsResponse,
} from '@ghostai/protocol';

export interface TelegramConsole {
  /**
   * Concrete, like `ServerRuntime.store` and for the reason stated there: this
   * port is narrow about *behaviour* — what a chat is allowed to reach — not
   * about types.
   */
  readonly store: SessionStore;
  readonly workspaces: WorkspaceStore;
  /** Agents a conversation may be bound to. */
  agents(): readonly AgentSummary[];
  /** What the configured endpoints answered with when last asked. */
  models(): Promise<ModelsResponse>;
  /**
   * Moves this process onto another model.
   *
   * Process-wide and not persisted, which is exactly what the terminal's
   * `/model` does — and the reason the command is admin-gated: it moves the
   * browser and every other chat too.
   */
  setModel(id: string): void;
  /** `undefined` when the session has nothing to measure yet. */
  context(sessionKey: string): Promise<ContextResponse | undefined>;
  /**
   * What this chat's agent remembers, and whether it may.
   *
   * A read, so it belongs on this side of the split rather than in a frame.
   */
  memory(sessionKey: string): Promise<MemoryState>;
  /**
   * Folds the oldest part of a conversation into memory.
   *
   * **This is the one member that sits awkwardly on this side of the split.** It
   * rewrites what the next turn will send, which is the description of something
   * that should go out as a `ChannelControlFrame` so an open browser tab learns
   * the history moved. It does not, and the cost is bounded: the marker is read
   * at the *top* of a turn, so nothing breaks — a tab that was already open
   * simply shows a transcript longer than what is now sent, until it reloads.
   * Promoting this to a frame is a protocol change and a hub change; see
   * `docs/memory.md`.
   */
  compressMemory(sessionKey: string): Promise<MemoryCompression>;
}

/** Everything `/memory` prints without changing anything. */
export interface MemoryState {
  /** Whether the agent holds the `memory` tool. Absent counts as denied. */
  readonly granted: boolean;
  /** Estimated tokens the memory file costs in every prompt. `0` when empty. */
  readonly tokens: number;
  /** Estimated tokens of history not yet folded. */
  readonly historyTokens: number;
  /** Above this, `/memory` suggests compressing. Never acts on it. */
  readonly suggestAboveTokens: number;
}

/** What one `/memory compress` did. */
export interface MemoryCompression {
  readonly folded: number;
  readonly tokens: number;
}
