/**
 * The workspace manager over HTTP.
 *
 * A workspace is a named folder the user works in. `default` is the tree at
 * `<root>/workspace` and is also the parent of every named workspace, so it can
 * see all of them; a named workspace sees only itself.
 *
 * **No path ever crosses this boundary.** A workspace is created by name, gets
 * a derived slug, and lives at `<root>/workspace/<slug>`. Accepting a directory
 * from a client would turn "managed directories only" from a fact into a
 * convention, and the first request that sent `/` would hand an authenticated
 * caller the entire filesystem — including the vault sitting one level above
 * the workspace.
 *
 * **Deleting detaches; it does not remove.** The registry row goes and the
 * directory stays. A delete in a web UI is one click away from a misclick and
 * there is no undo for a recursive remove of a tree someone has been working
 * in — whereas a detached directory is re-adopted by creating a workspace with
 * the same name. Sessions are the one thing that blocks it: a workspace whose
 * conversations still name it answers 409 with the count, and
 * `POST /:id/sessions/move` is the way through.
 */

import {
  CreateWorkspaceRequestSchema,
  MoveSessionsRequestSchema,
  MoveSessionsResponseSchema,
  UpdateWorkspaceRequestSchema,
  WorkspaceListResponseSchema,
  WorkspaceSummarySchema,
  type CreateWorkspaceRequest,
  type MoveSessionsRequest,
  type MoveSessionsResponse,
  type UpdateWorkspaceRequest,
  type WorkspaceListResponse,
  type WorkspaceSummary,
} from '@ghostai/protocol';
import { DEFAULT_WORKSPACE_ID, type WorkspaceRecord } from '@ghostai/core';
import type { FastifyReply } from 'fastify';

import { conflict, notFound } from '../errors.js';
import { IdParamsSchema, type IdParams } from '../queries.js';
import type { RouteDeps, RouteGroup } from './types.js';

type WorkspaceRouteId =
  | 'workspaces.list'
  | 'workspaces.create'
  | 'workspaces.update'
  | 'workspaces.delete'
  | 'workspaces.moveSessions';

export function workspaceRoutes(deps: RouteDeps): RouteGroup<WorkspaceRouteId> {
  const workspaces = (): typeof deps.runtime.workspaces =>
    deps.runtime.workspaces;

  const summarise = (record: WorkspaceRecord): WorkspaceSummary => ({
    id: record.id,
    name: record.name,
    isDefault: record.isDefault,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    sessionCount: deps.runtime.store.countByWorkspace(record.id),
  });

  const require = (id: string): WorkspaceRecord => {
    const record = workspaces().get(id);
    if (record === undefined) throw notFound(`No such workspace: ${id}`);
    return record;
  };

  return {
    'workspaces.list': {
      summary: 'Every workspace, the default first',
      schema: { response: { 200: WorkspaceListResponseSchema } },
      handler: (): WorkspaceListResponse => ({
        workspaces: workspaces().list().map(summarise),
      }),
    },

    'workspaces.create': {
      summary: 'Create a workspace and its folder',
      schema: {
        body: CreateWorkspaceRequestSchema,
        response: { 201: WorkspaceSummarySchema },
      },
      handler: (request, reply): WorkspaceSummary => {
        const body = request.body as CreateWorkspaceRequest;
        // The store owns slug derivation, uniqueness, the reserved names and
        // the refusal to sit on top of an existing file. It throws typed
        // `GhostError`s that the error handler already maps to status codes,
        // so there is nothing to re-validate here.
        const created = workspaces().create({
          name: body.name,
          ...(body.id === undefined ? {} : { id: body.id }),
        });
        void reply.status(201);
        return summarise(created);
      },
    },

    'workspaces.update': {
      summary: 'Rename a workspace, move its folder, or both',
      schema: {
        params: IdParamsSchema,
        body: UpdateWorkspaceRequestSchema,
        response: { 200: WorkspaceSummarySchema },
      },
      handler: (request): WorkspaceSummary => {
        const { id } = request.params as IdParams;
        const { name, id: folder } = request.body as UpdateWorkspaceRequest;
        let record = require(id);

        // The name first, and against the *old* id, so a body carrying both
        // does not have to guess which one the row is keyed on mid-request.
        if (name !== undefined) record = workspaces().rename(record.id, name);

        if (folder !== undefined && folder !== record.id) {
          const from = record.id;
          // The store moves the directory and the row together and refuses the
          // default, whose folder is the root every other workspace sits in.
          record = workspaces().relocate(from, folder);
          // Then everything that resolved through the old id follows it. Not in
          // the store: `sessions` is another store's table, and the jail cache
          // is not a store at all.
          deps.runtime.store.reassignWorkspace(from, record.id);
          deps.runtime.releaseWorkspace(from);
        }

        return summarise(record);
      },
    },

    'workspaces.delete': {
      summary: 'Detach a workspace, keeping its files',
      schema: { params: IdParamsSchema },
      handler: (request, reply): FastifyReply => {
        const { id } = request.params as IdParams;
        const record = require(id);

        // Counted before anything is removed. The count is what the UI renders
        // in its "move them to Default first" affordance, so it belongs in the
        // error rather than only in the message.
        const sessionCount = deps.runtime.store.countByWorkspace(record.id);
        if (sessionCount > 0) {
          throw conflict(
            `${String(sessionCount)} session${sessionCount === 1 ? '' : 's'} still use this workspace`,
            { sessionCount, workspaceId: record.id },
          );
        }

        workspaces().delete(record.id);
        return reply.status(204).send();
      },
    },

    'workspaces.moveSessions': {
      summary: 'Move every session in a workspace to another one',
      schema: {
        params: IdParamsSchema,
        body: MoveSessionsRequestSchema,
        response: { 200: MoveSessionsResponseSchema },
      },
      handler: (request): MoveSessionsResponse => {
        const { id } = request.params as IdParams;
        const { to } = request.body as MoveSessionsRequest;
        // Both ends must exist. Moving *into* a workspace nobody can name
        // would strand the conversations somewhere the UI cannot show them,
        // which is worse than the delete this was meant to unblock.
        const from = require(id);
        require(to);
        if (from.id === to) {
          throw conflict('A workspace cannot be moved into itself', {
            workspaceId: from.id,
          });
        }
        return { moved: deps.runtime.store.reassignWorkspace(from.id, to) };
      },
    },
  };
}

/** Re-exported so the manifest's default is stated in one place. */
export { DEFAULT_WORKSPACE_ID };
