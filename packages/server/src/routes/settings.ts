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
  DEFAULT_AGENT_ID,
  RESERVED_AGENT_IDS,
  SetCredentialRequestSchema,
  SettingsPatchRequestSchema,
  SettingsResponseSchema,
  isAgentId,
  type AgentEntry,
  type AgentRename,
  type Config,
  type ConfigPatch,
  type SetCredentialRequest,
  type SettingsPatchRequest,
  type SettingsResponse,
} from '@ghostai/protocol';
import type { FastifyReply } from 'fastify';

import { assertBootPolicy } from '../boot.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import type { RouteDeps, RouteGroup } from './types.js';

type SettingsRouteId =
  'settings.get' | 'settings.patch' | 'settings.credential' | 'settings.reload';

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
  const loadError = deps.runtime.loadError();
  return {
    config: deps.runtime.config(),
    credentialsPresent: deps.runtime.credentialsPresent(),
    ...(loadError === undefined ? {} : { loadError }),
    // Read fresh on every response rather than only after a write: a warning
    // most often comes from the file as it was found at boot, and the first
    // request for the settings tree is where anyone would look for it.
    warnings: [...deps.runtime.configWarnings()],
  };
}

/**
 * The key moves a rename asks for, as the patch that performs them.
 *
 * Three edits at once, and they have to be one patch rather than three: each
 * intermediate state has either a dangling delegation or two agents holding the
 * same entry, and `reconfigure` validates — and prunes — every state it is given.
 *
 * Refused here rather than left to the merge, because the merge would happily
 * write any of them and the operator would find out from the next turn:
 *
 *  - the source has to exist, and must not be `default`, which is resolvable
 *    whether or not it has an entry and which nothing downstream can do without
 *  - the target has to be a usable id, not reserved, and not already taken
 *
 * `agents.list.*` is replaced wholesale rather than merged, so every entry built
 * here is a complete agent and not a diff of one.
 */
function renamePatch(current: Config, renames: readonly AgentRename[]): ConfigPatch {
  const list: Record<string, AgentEntry | null> = {};
  // Applied against a copy so a second rename in the same request sees the first
  // one's result — renaming a → b and b → c in one save is odd but expressible,
  // and silently letting the second land on the *old* b would be worse.
  const pending: Record<string, AgentEntry> = { ...current.agents.list };

  for (const { from, to } of renames) {
    if (from === DEFAULT_AGENT_ID) {
      throw unprocessable('The default agent cannot be renamed.', { agentId: from });
    }
    const entry = pending[from];
    if (entry === undefined) throw notFound(`No such agent: ${from}`);
    if (to === from) continue;
    if (!isAgentId(to) || RESERVED_AGENT_IDS.has(to)) {
      throw unprocessable(
        `"${to}" cannot be used as an agent id.\n` +
          '  Ids are lower-case letters, digits and hyphens, up to 40 characters,\n' +
          '  and cannot be a reserved device name.',
        { agentId: to },
      );
    }
    if (pending[to] !== undefined) throw conflict(`There is already an agent called "${to}".`);

    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the key is the operator's
    delete pending[from];
    pending[to] = entry;
    list[from] = null;
    list[to] = entry;

    // Every *other* agent that delegates to the old id follows it. Read off
    // `pending` so a delegation rewritten by an earlier rename in this same
    // request is rewritten again rather than reverted.
    for (const [id, other] of Object.entries(pending)) {
      if (id === to) continue;
      if (!other.subagents.some((ref) => ref.id === from)) continue;
      const moved = {
        ...other,
        subagents: other.subagents.map((ref) => (ref.id === from ? { ...ref, id: to } : ref)),
      };
      pending[id] = moved;
      list[id] = moved;
    }
  }

  return { agents: { list } };
}

/**
 * Drops standing tool approvals for agents this write removed.
 *
 * On both writers, because both can remove an agent: a patch does it directly,
 * and a reload does it by re-reading a file someone edited by hand.
 *
 * The thing it prevents is not a stale cache but a privilege carried across an
 * identity boundary. An agent id is user-authored and re-creatable, so deleting
 * `reviewer` and creating a new `reviewer` produces two different agents that
 * share a key — and without this the second inherits every standing "always
 * allow" the first was ever granted.
 */
function forgetDepartedAgents(deps: RouteDeps): void {
  deps.hub.retainAgents(new Set(deps.runtime.agents().map((agent) => agent.id)));
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
      // The deep-partial `ConfigPatch`, plus `renameAgents`: a plain
      // `.partial()` leaves each field's `.default()` in place, so saving one
      // panel would rewrite every untouched field in the tree back to its
      // default.
      schema: { body: SettingsPatchRequestSchema, response: { 200: SettingsResponseSchema } },
      handler: (request): SettingsResponse => {
        const { renameAgents = [], ...patch } = request.body as SettingsPatchRequest;
        assertServable(deps.runtime.config(), patch);

        // The renames and the patch go in as **one** merge, which is the whole
        // reason they travel together: as two writes, the first can land and the
        // second fail, leaving an agent under its new name holding its old
        // settings. Renames first so the caller's patch addresses the new ids —
        // and last-writer-wins on `agents.list` is what the caller wants there,
        // because their entry is the edited one and the rename's is the copy.
        const moves = renamePatch(deps.runtime.config(), renameAgents);
        deps.runtime.applySettings(
          renameAgents.length === 0
            ? patch
            : {
                ...patch,
                agents: {
                  ...patch.agents,
                  list: { ...moves.agents?.list, ...patch.agents?.list },
                },
              },
        );

        // The stores the settings tree does not reach, each all-or-nothing and
        // in this order for a reason.
        //
        // *After* the config, because a save refused by `applySettings` — an
        // unbuildable agent, an unservable server block — must not have already
        // moved conversations onto an id the config never took. Config first
        // means a failure here leaves them pointing at an id that no longer
        // resolves, which is the case the default-agent fallback exists for and
        // which re-running the save repairs. The other order would move the
        // conversations and then fail to record why.
        //
        // One transaction rather than one per rename, so a save carrying two
        // cannot land half of them.
        deps.runtime.store.reassignAgents(renameAgents);
        // In-memory and last, because it cannot fail in a way worth ordering
        // around. The same agent, so its standing tool approvals follow it; a
        // delete-and-recreate is a *different* agent and deliberately does not
        // — see `forgetDepartedAgents`.
        for (const { from, to } of renameAgents) {
          if (from !== to) deps.hub.renameAgent(from, to);
        }

        forgetDepartedAgents(deps);
        // On both writers, for the reason `forgetDepartedAgents` is on both:
        // a patch and a reload can each move `scheduler.*`. The engine reads
        // `enabled`, `concurrency` and `runRetention` live, but its *timer* is
        // armed from what was due when it last looked — so without this,
        // switching the scheduler on does nothing until a restart.
        deps.scheduler?.()?.refresh();
        return settingsResponse(deps);
      },
    },

    'settings.reload': {
      summary: 'Re-read config.json from disk and rebuild what depends on it',
      // The settings tree on the way out, because that is the question the
      // caller is really asking: not "did it work" but "what is it running
      // now". A body of `{ ok: true }` would send every caller straight back
      // for the answer, and would be a second shape to keep in step with the
      // one `settings.get` already publishes.
      schema: { response: { 200: SettingsResponseSchema } },
      handler: (): SettingsResponse => {
        deps.runtime.reload();
        forgetDepartedAgents(deps);
        // On both writers, for the reason `forgetDepartedAgents` is on both:
        // a patch and a reload can each move `scheduler.*`. The engine reads
        // `enabled`, `concurrency` and `runRetention` live, but its *timer* is
        // armed from what was due when it last looked — so without this,
        // switching the scheduler on does nothing until a restart.
        deps.scheduler?.()?.refresh();
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
