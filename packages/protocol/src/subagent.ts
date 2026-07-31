/**
 * The vocabulary a delegated run is recorded under.
 *
 * Small, and here rather than beside the loop that writes it, because four
 * layers read it and they cannot all reach the same one otherwise: the session
 * store filters on the origin, the loop writes the lineage, the server hands the
 * bag through, and the browser reads the pointer back to fetch a subagent's
 * transcript after a reload. A constant duplicated across that span is a string
 * that eventually differs in one of them.
 *
 * The mechanism is `forkSession`'s: lineage lives in the session's metadata bag
 * rather than in a column. It costs no schema, no index and no query surface,
 * and nothing needs to search by it — the parent holds a map of its children,
 * and each child holds a pointer back.
 */

import { z } from 'zod';

/**
 * The origin a subagent's session is recorded under.
 *
 * Load-bearing rather than descriptive: `listSessions` excludes it, which is
 * what keeps one-turn machine-started sessions out of the list of conversations
 * a person had.
 */
export const SUBAGENT_ORIGIN = 'subagent';

/** Where a subagent's session records what delegated to it. */
export const SUBAGENT_METADATA_KEY = 'subagent';

/** Where a *parent* session records which call produced which child session. */
export const SUBAGENT_RUNS_METADATA_KEY = 'subagentRuns';

/** What a subagent's session knows about the call that started it. */
export interface SubagentLineage {
  readonly parentSessionKey: string;
  readonly parentTurnId: string;
  readonly parentCallId: string;
  readonly agentId: string;
  /** 1 for a subagent of the session's own agent. */
  readonly depth: number;
}

/**
 * What a parent remembers about one delegation, once the events are gone.
 *
 * The session key alone would do to *fetch* the run; the agent and its label
 * are here so a rebuilt transcript can name the card before the fetch resolves.
 * Without them a reloaded conversation would render "Subagent run" over a
 * spinner and only learn whose run it was afterwards, which is a flicker on
 * every delegation in the history.
 */
export const SubagentRunRefSchema = z.object({
  sessionKey: z.string().min(1),
  agentId: z.string(),
  label: z.string(),
});
export type SubagentRunRef = z.infer<typeof SubagentRunRefSchema>;

/**
 * `callId → run`, read out of a parent session's metadata.
 *
 * Tolerant of anything that is not the expected shape, for the same reason the
 * store's own `parseMetadata` is: the bag is untyped storage that other things
 * also write, and one malformed entry must not stop a transcript rendering.
 */
export function subagentRunsOf(
  metadata: Readonly<Record<string, unknown>>,
): Readonly<Record<string, SubagentRunRef>> {
  const raw = metadata[SUBAGENT_RUNS_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

  const runs: Record<string, SubagentRunRef> = {};
  for (const [callId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const { sessionKey, agentId, label } = value as Record<string, unknown>;
    if (typeof sessionKey !== 'string' || sessionKey === '') continue;
    runs[callId] = {
      sessionKey,
      agentId: typeof agentId === 'string' ? agentId : '',
      label: typeof label === 'string' ? label : '',
    };
  }
  return runs;
}

/** Adds one run to a parent's map, returning the whole metadata bag. */
export function withSubagentRun(
  metadata: Readonly<Record<string, unknown>>,
  callId: string,
  run: SubagentRunRef,
): Readonly<Record<string, unknown>> {
  return {
    ...metadata,
    [SUBAGENT_RUNS_METADATA_KEY]: { ...subagentRunsOf(metadata), [callId]: run },
  };
}
