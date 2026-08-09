/**
 * What may name a workspace, re-exported.
 *
 * The rules themselves live in `@ghostwire/protocol` because both sides need
 * them: `paths.ts` turns an id into a directory and `workspace-store.ts`
 * decides whether one may be created, while the browser *mints* one — the
 * create form asks for the folder as its own field and has to propose a legal
 * slug before the request. Two implementations of a rule whose whole job is
 * that two things cannot collide is not a rule.
 *
 * This file keeps the import path every consumer of `@ghostwire/core` already
 * uses, exactly as `slug-id.ts` does for the character rules underneath.
 */

export {
  DEFAULT_WORKSPACE_ID,
  RESERVED_WORKSPACE_IDS,
  WORKSPACE_ID_PATTERN,
  deriveWorkspaceId,
  isWorkspaceId,
} from '@ghostwire/protocol';
