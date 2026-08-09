/**
 * Query-string and path-parameter schemas.
 *
 * These live here rather than in `@ghostwire/protocol` for one reason: a query
 * string carries only strings, so `limit=50` arrives as `"50"` and a schema that
 * validates it has to coerce. `@ghostwire/protocol` forbids `.transform()` outright
 * — every schema there must have identical input and output types so the OpenAPI
 * document generated from it describes what the server enforces — and `z.coerce`
 * is a transform wearing a different name.
 *
 * So the coercion lives on this side of the boundary, next to the transport that
 * makes it necessary. `PaginationQuerySchema` in the protocol states the shape a
 * client sends; `PageQuerySchema` below is that shape as it arrives, and
 * `queries.test.ts` holds the two together.
 *
 * Each export is annotated as `z.ZodType<T>` with `T` written out, which is the
 * one place in the repo a schema does not infer its own type: this package keeps
 * `isolatedDeclarations` on, and an inferred `ZodObject<…>` has no declaration
 * the emitter can write. The annotation is checked against the schema, so the
 * pair cannot drift silently — a field added to one and not the other fails to
 * compile.
 *
 * They are not DTOs and are not registered in `PROTOCOL_SCHEMAS`: a query schema
 * always inlines into the document as parameters, so a `$ref` would have nothing
 * to point at.
 */

import { DEFAULT_WORKSPACE_ID } from '@ghostwire/core';
import { z } from 'zod';

/** The bounds the protocol's `PaginationQuery` states, restated once. */
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

const pageShape = {
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
  /** Opaque; echoed back from `nextCursor`. See `cursor.ts`. */
  cursor: z.string().optional(),
  /**
   * Rows to skip from the top, for a numbered pager.
   *
   * In the shared shape rather than on the one endpoint that needed it first,
   * because every paged listing here answers the same two kinds of reader — see
   * `PaginationQuerySchema` in the protocol for which wants which, and why
   * sending both is a 400 rather than a precedence rule.
   *
   * Left `optional()` and defaulted in the handler rather than defaulted to `0`
   * here: `0` and "absent" have to stay distinguishable, or a request carrying
   * only a cursor arrives with an offset it never sent and trips the guard.
   */
  offset: z.coerce.number().int().nonnegative().optional(),
};

export interface PageQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly offset?: number | undefined;
}

export const PageQuerySchema: z.ZodType<PageQuery> = z.object(pageShape);

/** The columns `GET /api/sessions` will order by. Mirrors `SessionOrderBy`. */
const SESSION_SORT_KEYS = ['updated', 'created', 'title'] as const;

export interface SessionListQuery extends PageQuery {
  /** `web`, `telegram`, `automation`, an extension id. Absent means every origin. */
  readonly origin?: string | undefined;
  /**
   * One origin to leave out. Absent means none is.
   *
   * The sidebar sends `subagent`: a shortlist of thirty is a list of
   * conversations, and a delegated run is a step inside one. Excluded here
   * rather than dropped from the response so the thirty stay thirty — see
   * `sessionFilter` in the store.
   */
  readonly excludeOrigin?: string | undefined;
  /** Absent means every workspace, which is what the unscoped sidebar asks for. */
  readonly workspace?: string | undefined;
  /** A title substring. Blank is the same as absent — see `ListSessionsOptions.query`. */
  readonly q?: string | undefined;
  readonly sort?: (typeof SESSION_SORT_KEYS)[number] | undefined;
  readonly desc?: boolean | undefined;
}

export const SessionListQuerySchema: z.ZodType<SessionListQuery> = z.object({
  ...pageShape,
  origin: z.string().min(1).optional(),
  excludeOrigin: z.string().min(1).optional(),
  workspace: z.string().min(1).optional(),
  // No `.min(1)`: an empty box is a legal thing for a client to send, and the
  // store already treats blank as "no filter". Rejecting it would make clearing
  // the search field a 400.
  q: z.string().optional(),
  sort: z.enum(SESSION_SORT_KEYS).optional(),
  // An enum rather than `z.stringbool()`, matching `NotificationListQuery`: the
  // generated document then lists the two values a client may send instead of
  // saying "string".
  desc: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export interface NotificationListQuery extends PageQuery {
  readonly unread?: boolean | undefined;
}

export const NotificationListQuerySchema: z.ZodType<NotificationListQuery> =
  z.object({
    ...pageShape,
    // An enum rather than `z.stringbool()`, so the generated document lists the
    // two values a client may send instead of saying "string".
    unread: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  });

export interface WsQuery {
  /** The session to open on. Absent asks the hub to mint one. */
  readonly session?: string | undefined;
  /**
   * The agent a session *created* by this connection is bound to.
   *
   * A default for the connection, not an override: a frame may name its own,
   * and a session that already exists keeps the agent it was created with. It
   * is here for the same reason `workspaceId` reaches the hub — a tab connects
   * before it has sent anything, and the store holds no row until the first
   * message lands.
   */
  readonly agent?: string | undefined;
}

/**
 * The socket's query parameters.
 *
 * Validated before the upgrade rather than after, so a client that sends
 * `?session=` gets a 400 it can read instead of a socket that opens, mints a
 * session it did not ask for, and looks like it lost the conversation.
 */
export const WsQuerySchema: z.ZodType<WsQuery> = z.object({
  session: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});

export interface PathQuery {
  readonly path: string;
  /**
   * Which workspace the path is relative to.
   *
   * A query parameter rather than a header or a `/api/workspaces/:id/files`
   * prefix. A header would be invisible in the generated OpenAPI document and
   * in a pasted `curl`, and would need a `Vary`; a path prefix would double the
   * file surface and rewrite every URL for no gain over a parameter the
   * document already describes.
   *
   * It is authorised, not authorising. There is one principal here and it can
   * already reach the whole tree, so naming a workspace is not a privilege
   * decision — what the routes must do with it is refuse an id with no registry
   * row, so a crafted value cannot bring a directory into existence.
   */
  readonly workspace: string;
}

/**
 * A workspace-relative path in a query string.
 *
 * Never validated for safety here — that is `WorkspaceJail`'s job and only its
 * job. This says the parameter is present and is a string; whether it is a legal
 * path is decided by the jail, in one place, for every caller.
 */
export const PathQuerySchema: z.ZodType<PathQuery> = z.object({
  path: z.string().min(1),
  workspace: z.string().min(1).default(DEFAULT_WORKSPACE_ID),
});

/** The directory listing's path, where absent means the workspace root. */
export const OptionalPathQuerySchema: z.ZodType<PathQuery> = z.object({
  path: z.string().default('.'),
  workspace: z.string().min(1).default(DEFAULT_WORKSPACE_ID),
});

export interface DeleteQuery extends PathQuery {
  readonly recursive?: boolean | undefined;
}

/**
 * A delete, and whether it may take a directory's contents with it.
 *
 * The flag exists so that emptying a tree cannot be something a request
 * *happens* to do. A bare `DELETE /api/files?path=notes` removes an empty
 * directory and refuses a full one — so a mistyped path, a stale bookmark or a
 * script looping over names cannot recurse, and the caller that means it has to
 * say a word that only means that.
 *
 * An enum rather than `z.stringbool()`, matching `NotificationListQuery`: the
 * generated document then lists the two values a client may send instead of
 * saying "string".
 */
export const DeleteQuerySchema: z.ZodType<DeleteQuery> = z.object({
  path: z.string().min(1),
  workspace: z.string().min(1).default(DEFAULT_WORKSPACE_ID),
  recursive: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export interface TurnsQuery {
  readonly limit: number;
}

/**
 * Deliberately not `PageQuerySchema`.
 *
 * There is no turn cursor — `turn_stats` is read newest-first off one index and
 * a conversation has orders of magnitude fewer turns than messages. Accepting a
 * `cursor` that is then ignored would put a parameter in the OpenAPI document
 * that the server does not honour, which is a lie the document cannot recover
 * from.
 */
export const TurnsQuerySchema: z.ZodType<TurnsQuery> = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_LIMIT)
    .default(DEFAULT_PAGE_LIMIT),
});

export interface SessionParams {
  readonly key: string;
}

export const SessionParamsSchema: z.ZodType<SessionParams> = z.object({
  key: z.string().min(1),
});

export interface IdParams {
  readonly id: string;
}

export const IdParamsSchema: z.ZodType<IdParams> = z.object({
  id: z.string().min(1),
});

interface TokenParams {
  readonly token: string;
}

export const TokenParamsSchema: z.ZodType<TokenParams> = z.object({
  token: z.string().min(1),
});
