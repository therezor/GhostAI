/**
 * The workspace's skill catalogue, for the composer's `@skill:` autocomplete.
 *
 * This is the one thing the mention needed that nothing served. `@skill:foo`
 * inlines that sheet into a message, so the name has to be exact — and the
 * catalogue only ever existed in the model's prompt and on disk, which is to say
 * everywhere except the screen of the person typing the mention. The autocomplete
 * used to complete the namespace and then offer nothing, because there was
 * nothing to offer.
 *
 * **Names and descriptions, never bodies.** A sheet runs to `SKILL_MAX_BYTES`
 * and its one destination is the prompt, which the agent assembles for itself. A
 * client holding a copy would be holding it to display nothing.
 *
 * Read from disk on request rather than from a cache, for the same reason
 * `SkillsContributor` re-reads every turn: `skills/` is workspace content that a
 * turn can write and `/workspace` can switch out from under. It is a `readdir`
 * and a handful of small files.
 */

import { readSkills } from '@ghostai/agent';
import { DEFAULT_WORKSPACE_ID } from '@ghostai/core';
import {
  SkillListResponseSchema,
  type SkillListResponse,
} from '@ghostai/protocol';

import { notFound } from '../errors.js';
import type { RouteDeps, RouteGroup } from './types.js';

interface SkillsQuery {
  readonly workspace?: string;
}

export function skillRoutes(deps: RouteDeps): RouteGroup<'skills.list'> {
  return {
    'skills.list': {
      summary: 'The skills this workspace holds, as names and descriptions',
      schema: { response: { 200: SkillListResponseSchema } },
      handler: async (request): Promise<SkillListResponse> => {
        const { workspace } = request.query as SkillsQuery;
        const workspaceId = workspace ?? DEFAULT_WORKSPACE_ID;

        // The registry lookup before the jail, exactly as `files.ts` does it and
        // for the same reason: `jailFor` resolves any legal slug on purpose, so
        // "may this caller see this workspace" is a question that has to be
        // asked here rather than left to the path resolver.
        if (deps.runtime.workspaces.get(workspaceId) === undefined) {
          throw notFound(`No such workspace: ${workspaceId}`);
        }
        const jail = deps.runtime.agent().jailFor(workspaceId);

        // Already sorted by name — `readSkills` sorts so the cached prompt
        // prefix cannot move between hosts, and the same order is the one a
        // person sees in the popover.
        const skills = await readSkills(jail.root, {
          ...(deps.logger === undefined ? {} : { logger: deps.logger }),
        });

        return {
          skills: skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
          })),
        };
      },
    },
  };
}
