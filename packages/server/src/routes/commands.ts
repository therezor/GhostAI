/**
 * The slash commands extensions contribute, listed and run.
 *
 * The first server-side command surface, and it exists because an extension's
 * command is the case the three hand-written tables cannot cover. The header of
 * `packages/web/src/chat/commands.ts` explains why `/new` is written out three
 * times — in the composer, in the terminal and in Telegram — and why a shared
 * core would have to be the union of three sets of constraints: the surfaces
 * agree on a vocabulary rather than on an implementation. An extension breaks
 * the symmetry, because there is exactly one definition of `/slack-post` and
 * every surface has to reach it. So this is fetched rather than compiled in.
 *
 * Two consequences a reader should expect:
 *
 *  - **The answer is text, not a resource key.** Every built-in command answers
 *    with a key its caller renders; an extension's copy ships with the
 *    extension and the translation layer has never seen it. The same rule a
 *    toolbox's `notes` follows.
 *  - **A command that throws is a 200 with `ok: false`.** An extension's bug
 *    should read as "that did not work" in the composer, not as a 500 in the
 *    console — and the operator typed a command, which is not the kind of act
 *    that deserves an error envelope. A command that does not *exist* is still
 *    a 404, because that is the client asking for something wrong.
 */

import { GhostError } from '@ghostai/core';
import {
  CommandListResponseSchema,
  RunCommandRequestSchema,
  RunCommandResponseSchema,
  type CommandListResponse,
  type RunCommandRequest,
  type RunCommandResponse,
} from '@ghostai/protocol';

import type { FastifyRequest } from 'fastify';

import type { RouteDeps, RouteGroup } from './types.js';

interface CommandParams {
  readonly id: string;
}

export function commandRoutes(
  deps: RouteDeps,
): RouteGroup<'commands.list' | 'commands.run'> {
  return {
    'commands.list': {
      summary: 'Every slash command extensions contribute',
      schema: { response: { 200: CommandListResponseSchema } },
      // An install with no extensions answers with an empty list rather than a
      // 501: it has no extension commands, which is what the composer asked.
      handler: (): CommandListResponse => ({
        commands: [...(deps.runtime.commands?.() ?? [])],
      }),
    },

    'commands.run': {
      summary: 'Run one extension command',
      schema: {
        body: RunCommandRequestSchema,
        response: { 200: RunCommandResponseSchema },
      },
      handler: async (request): Promise<RunCommandResponse> => {
        const id = (request.params as CommandParams).id;
        // Bound rather than captured bare, so the optional-method check and
        // the call cannot disagree about `this` — the same reason
        // `serve.ts` binds `chat`.
        const run = deps.runtime.runCommand?.bind(deps.runtime);
        if (run === undefined) {
          throw new GhostError('not_found', `No command called "${id}"`);
        }
        const body = request.body as RunCommandRequest;
        // The request's own signal, so a composer that navigated away stops
        // whatever the command was doing. The same single-cancellation rule
        // every other long-running route follows.
        return await run(id, { ...body, signal: abortOf(request) });
      },
    },
  };
}

/**
 * A signal that fires when the client hangs up.
 *
 * Built from the raw request's `close` rather than taken from somewhere:
 * Fastify has no `AbortSignal` of its own, and the socket closing is the only
 * thing that actually says the operator navigated away. It also fires once the
 * response is written, which is harmless — the handler has already resolved by
 * then and an abort with nothing listening is a no-op.
 *
 * `once`, so a keep-alive connection serving many commands does not accumulate
 * a listener per request.
 */
function abortOf(request: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  request.raw.once('close', () => {
    controller.abort();
  });
  return controller.signal;
}
