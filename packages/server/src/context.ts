/**
 * What the agent would send to the model, for one session.
 *
 * Extracted from `routes/sessions.ts` rather than duplicated, because the
 * interesting twenty lines here are not glue — they are the *agent-resolution
 * policy*, and two surfaces disagreeing about which agent a conversation is
 * measured against is exactly the class of bug that made `describeContext` a
 * shared function in the first place.
 *
 * The policy: a session is measured against **its own agent**, since that
 * agent's tools, prompt and context window are what a turn here would actually
 * carry, and a meter read against another agent's window is simply wrong.
 * Unless the session names an agent that has since been deleted, in which case
 * the honest answer is the one a turn *would* get — the default — reported
 * through `requestedAgentId` so a reader can be told what they are looking at
 * rather than quietly shown something else.
 */

import { describeContext } from '@ghostwire/agent';
import { toStoredMessage } from '@ghostwire/core';
import type { ContextResponse } from '@ghostwire/protocol';

import type { ServerRuntime } from './runtime.js';

/** The slice of the runtime this needs. Structural, so a test can stand in. */
type ContextRuntime = Pick<ServerRuntime, 'agents' | 'agent' | 'store'>;

/**
 * Measures one session, or `undefined` when there is nothing to measure.
 *
 * `undefined` rather than a throw, because the two callers want different
 * things from it: the route turns it into a 404, and a chat channel says
 * "nothing to measure yet" — a conversation that has been created but not
 * spoken in is normal, not an error.
 */
export async function buildContextResponse(
  runtime: ContextRuntime,
  sessionKey: string,
): Promise<ContextResponse | undefined> {
  const session = runtime.store.getSession(sessionKey);
  if (session === undefined) return undefined;

  const bound = session.agentId;
  const missing =
    bound !== undefined &&
    bound !== '' &&
    !runtime.agents().some((entry) => entry.id === bound);
  const effectiveId = missing ? undefined : bound;
  const agent = runtime.agent(effectiveId);

  // The measurement itself lives in `@ghostwire/agent`, so every surface reports
  // the same numbers from the same code rather than a second implementation of
  // the windowing rules.
  const report = await describeContext({
    store: runtime.store,
    loop: { previewPrompt: (input) => agent.systemPrompt(input) },
    tools: agent.tools,
    sessionKey,
    channel: 'web',
    // The effective id, not the stored one: this reaches `previewPrompt`, and a
    // preview built for an agent that will not run is a preview of something
    // that is not going to happen.
    ...(effectiveId === undefined ? {} : { agentId: effectiveId }),
    contextWindowTokens: agent.contextWindowTokens,
  });
  if (report === undefined) return undefined;

  return {
    sessionKey: report.sessionKey,
    systemPrompt: report.systemPrompt,
    runtimeBlock: report.runtimeBlock,
    tools: [...report.tools],
    messages: report.messages.map(toStoredMessage),
    estimatedTokens: report.estimatedTokens,
    contextWindowTokens: report.contextWindowTokens,
    breakdown: { ...report.breakdown },
    agentId: agent.id,
    // Present only on a fallback, so a client can treat its presence as the
    // whole signal rather than comparing two ids on every response.
    ...(missing ? { requestedAgentId: bound } : {}),
  };
}
