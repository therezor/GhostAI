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
}
