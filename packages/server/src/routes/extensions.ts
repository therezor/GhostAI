/**
 * What each installed extension actually is, and the two buttons on its row.
 *
 * The listing is `GET /api/mcp`'s sibling and reads the same way: the settings
 * tree says which extensions an operator disabled, and this says what happened
 * when the install tried to load them. "Never approved", "changed since
 * approval" and "threw on activation" are three different things to do next,
 * and none of them belongs in `config.json`.
 *
 * Approve and revoke are **not** settings patches, and that is the design
 * rather than an omission. An approval is a statement about the exact bytes on
 * disk at one moment — recorded as a digest in the database, next to the
 * toolbox approvals it copies. Writing it into `config.json` would make it
 * survive an edit to the very files it was about, which is the one thing the
 * whole gate exists to prevent.
 *
 * `POST` for both, and neither is idempotent in the way a `PUT` promises:
 * approving records *what is on disk now*, so approving twice across an edit
 * approves two different things. That is the intended behaviour and the verb
 * should say so.
 */

import { GhostError } from '@ghostai/core';
import {
  ExtensionListResponseSchema,
  type ExtensionListResponse,
} from '@ghostai/protocol';

import type { RouteDeps, RouteGroup } from './types.js';

interface ExtensionParams {
  readonly id: string;
}

export function extensionRoutes(
  deps: RouteDeps,
): RouteGroup<'extensions.list' | 'extensions.approve' | 'extensions.revoke'> {
  const params = (request: { params: unknown }): string =>
    (request.params as ExtensionParams).id;

  /**
   * The one refusal both writes share.
   *
   * A build with `extensions: false` has no host to approve anything with, and
   * a 501 is the honest answer: the request is well-formed and this install
   * cannot serve it. The listing takes the opposite line and answers `[]`,
   * because "which extensions do you have" has a true answer there and this
   * does not.
   */
  const requireHost = (): void => {
    if (deps.runtime.approveExtension === undefined) {
      throw new GhostError(
        'not_found',
        'This installation was built without the extension host.',
      );
    }
  };

  return {
    'extensions.list': {
      summary: 'Every installed extension and the state it is in',
      schema: { response: { 200: ExtensionListResponseSchema } },
      handler: (): ExtensionListResponse => ({
        extensions: [...(deps.runtime.extensionStatuses?.() ?? [])],
      }),
    },

    'extensions.approve': {
      summary: 'Approve the files an extension currently holds, and load it',
      schema: { response: { 200: ExtensionListResponseSchema } },
      handler: async (request): Promise<ExtensionListResponse> => {
        requireHost();
        await deps.runtime.approveExtension?.(params(request));
        // The whole list rather than the one row: approving loads the
        // extension, which can move another row — an id it shadows, a tool
        // name it takes. One request, one truthful picture.
        return { extensions: [...(deps.runtime.extensionStatuses?.() ?? [])] };
      },
    },

    'extensions.revoke': {
      summary: 'Forget an extension’s approval and unload it',
      schema: { response: { 200: ExtensionListResponseSchema } },
      handler: async (request): Promise<ExtensionListResponse> => {
        requireHost();
        await deps.runtime.revokeExtension?.(params(request));
        return { extensions: [...(deps.runtime.extensionStatuses?.() ?? [])] };
      },
    },
  };
}
