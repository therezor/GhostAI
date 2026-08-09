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
 * channel any extension registers. The composition root compiles this
 * channel in and hands it a store deliberately, which is a different act.
 *
 * Typed entirely in `@ghostwire/core` and `@ghostwire/protocol` vocabulary, because
 * that is the whole of what this package may import — and because it happens to
 * be the same vocabulary the REST API answers in, so `serve.ts` satisfies most
 * of it with what `ServerRuntime` already exposes.
 */

import type { SessionStore, WorkspaceStore } from '@ghostwire/core';
import type {
  AgentSummary,
  ContextResponse,
  ModelsResponse,
} from '@ghostwire/protocol';

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
   * The sheets this chat's workspace holds, and whether the agent may use them.
   *
   * Beside `memory` and for the same reason: a read against a store this package
   * may not open for itself. What it feeds is discovery rather than the prompt —
   * the catalogue is already in the prompt, and this is what puts it on a
   * person's screen.
   */
  skills(sessionKey: string): Promise<SkillsState>;
}

/** Everything `/memory` prints. It changes nothing. */
export interface MemoryState {
  /** Whether the agent holds the `memory` tool. Absent counts as denied. */
  readonly granted: boolean;
  /** How many memories the workspace holds. */
  readonly count: number;
  /** Estimated tokens their index costs in every prompt. `0` when there are none. */
  readonly tokens: number;
}

/** Everything `/skills` prints. It changes nothing. */
export interface SkillsState {
  /** Whether the agent holds the `skill` tool. Absent counts as denied. */
  readonly granted: boolean;
  /** Name and one line each, in the order the catalogue advertises them. */
  readonly skills: readonly SkillSummary[];
}

/** One row of the catalogue. The body stays on disk. */
export interface SkillSummary {
  readonly name: string;
  readonly description: string;
}
