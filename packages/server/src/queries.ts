/**
 * Query-string and path-parameter schemas.
 *
 * These live here rather than in `@ghostai/protocol` for one reason: a query
 * string carries only strings, so `limit=50` arrives as `"50"` and a schema that
 * validates it has to coerce. `@ghostai/protocol` forbids `.transform()` outright
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

import { z } from 'zod';

/** The bounds the protocol's `PaginationQuery` states, restated once. */
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 50;

const pageShape = {
  limit: z.coerce.number().int().positive().max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  /** Opaque; echoed back from `nextCursor`. See `cursor.ts`. */
  cursor: z.string().optional(),
};

export interface PageQuery {
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export const PageQuerySchema: z.ZodType<PageQuery> = z.object(pageShape);

export interface SessionListQuery extends PageQuery {
  /** `web`, `telegram`, `automation`, a plugin id. Absent means every origin. */
  readonly origin?: string | undefined;
}

export const SessionListQuerySchema: z.ZodType<SessionListQuery> = z.object({
  ...pageShape,
  origin: z.string().min(1).optional(),
});

export interface NotificationListQuery extends PageQuery {
  readonly unread?: boolean | undefined;
}

export const NotificationListQuerySchema: z.ZodType<NotificationListQuery> = z.object({
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
}

/**
 * The socket's only query parameter.
 *
 * Validated before the upgrade rather than after, so a client that sends
 * `?session=` gets a 400 it can read instead of a socket that opens, mints a
 * session it did not ask for, and looks like it lost the conversation.
 */
export const WsQuerySchema: z.ZodType<WsQuery> = z.object({
  session: z.string().min(1).optional(),
});

export interface PathQuery {
  readonly path: string;
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
});

/** The directory listing's path, where absent means the workspace root. */
export const OptionalPathQuerySchema: z.ZodType<PathQuery> = z.object({
  path: z.string().default('.'),
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

export interface TokenParams {
  readonly token: string;
}

export const TokenParamsSchema: z.ZodType<TokenParams> = z.object({
  token: z.string().min(1),
});
