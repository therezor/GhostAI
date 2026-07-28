/**
 * Settings, and the credentials that are deliberately not part of them.
 *
 * Two rules this module exists to hold:
 *
 *  - **`GET /api/settings` never returns a credential.** The vault is write-only
 *    over HTTP: a key goes in through `PUT /api/settings/credentials` and never
 *    comes back out, and the panel gets a per-provider boolean instead. Nothing
 *    relies on response serialisation to enforce that — the serializer is plain
 *    `JSON.stringify` and does not filter — so it is enforced by the response
 *    simply not containing one. (What the settings tree *does* carry is
 *    `providers.<id>.extraHeaders` and an MCP server's `headers`: those are
 *    operator-typed config that lives in `config.json` in the clear, and the
 *    panel showing them is the panel they were typed into.)
 *
 *  - **A patch that could not be served is refused at save time.** Saving
 *    `auth.enabled: false` against a LAN bind would leave an operator with a
 *    config file whose next boot is a refusal — the failure would surface on
 *    restart, long after the change that caused it.
 */

import {
  ConfigPatchSchema,
  SetCredentialRequestSchema,
  SettingsResponseSchema,
  type Config,
  type ConfigPatch,
  type SetCredentialRequest,
  type SettingsResponse,
} from '@ghostai/protocol';
import type { FastifyReply } from 'fastify';

import { assertBootPolicy } from '../boot.js';
import { badRequest } from '../errors.js';
import type { RouteDeps, RouteGroup } from './types.js';

type SettingsRouteId = 'settings.get' | 'settings.patch' | 'settings.credential';

/**
 * Whether the settings this patch produces could be served on the next boot.
 *
 * Only the `server` subtree is merged, and only shallowly, because that is all
 * `assertBootPolicy` reads. Reaching for the general deep merge would mean
 * either importing the composition root or reimplementing it — and a second
 * merge implementation that disagrees with the real one in some corner is worse
 * than a narrow one that cannot.
 */
function assertServable(current: Config, patch: ConfigPatch): void {
  const server = {
    ...current.server,
    host: patch.server?.host ?? current.server.host,
    port: patch.server?.port ?? current.server.port,
    auth: {
      ...current.server.auth,
      enabled: patch.server?.auth?.enabled ?? current.server.auth.enabled,
    },
  };
  try {
    assertBootPolicy({ config: { ...current, server } });
  } catch (error) {
    // A `config` GhostError is a 500 through the kind table, which is the right
    // answer for a config file the operator wrote and the wrong one for a body
    // this request just sent.
    throw badRequest(error instanceof Error ? error.message : 'Settings cannot be served');
  }
}

function settingsResponse(deps: RouteDeps): SettingsResponse {
  const loadError = deps.runtime.loadError?.();
  return {
    config: deps.runtime.config(),
    credentialsPresent: deps.runtime.credentialsPresent(),
    ...(loadError === undefined ? {} : { loadError }),
  };
}

export function settingsRoutes(deps: RouteDeps): RouteGroup<SettingsRouteId> {
  return {
    'settings.get': {
      summary: 'The settings tree, with credentials replaced by presence flags',
      schema: { response: { 200: SettingsResponseSchema } },
      handler: (): SettingsResponse => settingsResponse(deps),
    },

    'settings.patch': {
      summary: 'Apply a settings patch and rebuild what depends on it',
      // `ConfigPatch`, the deep-partial: a plain `.partial()` leaves each
      // field's `.default()` in place, so saving one panel would rewrite every
      // untouched field in the tree back to its default.
      schema: { body: ConfigPatchSchema, response: { 200: SettingsResponseSchema } },
      handler: (request): SettingsResponse => {
        const patch = request.body as ConfigPatch;
        assertServable(deps.runtime.config(), patch);
        deps.runtime.applySettings(patch);
        return settingsResponse(deps);
      },
    },

    'settings.credential': {
      summary: 'Store or clear one credential (write-only)',
      // No response schema, and no body on the way out. A route that echoed
      // what it stored would be a read path for a store that has none.
      schema: { body: SetCredentialRequestSchema },
      handler: (request, reply): FastifyReply => {
        deps.runtime.setCredential(request.body as SetCredentialRequest);
        return reply.status(204).send();
      },
    },
  };
}
