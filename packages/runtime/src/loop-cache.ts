/**
 * One `AgentLoop` per agent, kept between turns.
 *
 * A loop is cheap to hold and not free to build: it resolves a provider
 * instance, pulls an adapter out of the provider cache and freezes a tool
 * scope. Rebuilding one per turn would do all of that on every message, and —
 * worse — would make "a turn keeps the loop it started on" untrue, which is the
 * property that lets a settings save land safely while a turn is running.
 *
 * Three decisions, each mirroring `JailCache` because the problem is the same
 * shape:
 *
 *  - **The default agent is built eagerly and never evicted.** `Runtime.#build`
 *    computes everything able to fail before it mutates anything, and the
 *    default agent's provider resolution is what `configured`, `model` and
 *    `instance` all mean. Building it lazily would move that failure to the
 *    first turn after a save, which is exactly where it must not be.
 *
 *  - **Construction happens outside the map.** A `createLoop` that throws must
 *    not leave a poisoned entry behind, because the next call would return the
 *    failure rather than retrying it.
 *
 *  - **Eviction is a plain delete.** A loop owns no handles — the provider
 *    adapter it points at belongs to `ProviderCache`, which closes it on its own
 *    eviction — so dropping the reference is the whole of closing one.
 */

import type { AgentLoop } from '@ghostai/agent';
import { DEFAULT_AGENT_ID } from '@ghostai/core';

/**
 * Beyond this many live loops the least-recently-used is dropped.
 *
 * Sized for what an operator does: a handful of agents in play across a working
 * session. A miss costs one provider-cache lookup and one object.
 */
export const MAX_CACHED_LOOPS = 8;

export interface LoopCacheOptions {
  /**
   * Builds the loop for an agent id.
   *
   * Returns `null` when nothing can run — no provider resolved, or no model —
   * which is a state rather than an error, exactly as it is on the runtime.
   */
  readonly create: (agentId: string) => AgentLoop | null;
  readonly max?: number;
}

export class LoopCache {
  readonly #create: (agentId: string) => AgentLoop | null;
  readonly #max: number;
  /** Insertion-ordered, which is what makes the first key the LRU victim. */
  readonly #loops = new Map<string, AgentLoop>();

  constructor(options: LoopCacheOptions) {
    this.#create = options.create;
    this.#max = options.max ?? MAX_CACHED_LOOPS;
  }

  /**
   * The loop for an agent, built on first use.
   *
   * `null` propagates from `create` and is deliberately *not* cached: an
   * unconfigured install becomes configured by a settings save, and that save
   * rebuilds the runtime and drops this cache — but a null memoised here would
   * also have to be invalidated by anything else that could change the answer.
   * Nothing is gained by remembering "no".
   */
  get(agentId: string): AgentLoop | null {
    const cached = this.#loops.get(agentId);
    if (cached !== undefined) {
      // Re-insert so the working set stays at the young end of the map.
      this.#loops.delete(agentId);
      this.#loops.set(agentId, cached);
      return cached;
    }

    // Outside the map on purpose: a throw here must not be remembered.
    const loop = this.#create(agentId);
    if (loop === null) return null;

    this.#loops.set(agentId, loop);
    this.#evictIfFull();
    return loop;
  }

  /** How many loops are live. For tests and for a status page. */
  get size(): number {
    return this.#loops.size;
  }

  clear(): void {
    this.#loops.clear();
  }

  /**
   * Drops the least-recently-used entry, never the default.
   *
   * The default agent is the one every unbound session runs on, so evicting it
   * to make room for a named agent used once would guarantee a rebuild on the
   * very next turn.
   */
  #evictIfFull(): void {
    if (this.#loops.size <= this.#max) return;
    for (const key of this.#loops.keys()) {
      if (key === DEFAULT_AGENT_ID) continue;
      this.#loops.delete(key);
      return;
    }
  }
}
