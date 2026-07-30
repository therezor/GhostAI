/**
 * Sessions, their messages, and what the model would actually be sent.
 *
 * Cursor-paged, both listings, for the reason stated in `cursor.ts`: these are
 * the two tables that move under a reader. A page is fetched one row longer than
 * asked for and trimmed, so `nextCursor` is present exactly when there is
 * another row — a client never follows a cursor into an empty page, and never
 * stops one row early.
 *
 * `GET /api/sessions/:key/context` is the panel that makes the token budget
 * legible instead of a mystery. Two properties make it worth having rather than
 * misleading: the system prompt comes from the loop that would send it, and the
 * message window is produced by `historyForLLM` — the same function the loop
 * calls — rather than by a second implementation of the windowing rules.
 */

import {
  BranchSessionRequestSchema,
  ContextResponseSchema,
  CreateSessionRequestSchema,
  SessionListResponseSchema,
  SessionMessagesResponseSchema,
  SessionSummarySchema,
  TurnStatsResponseSchema,
  UpdateSessionRequestSchema,
  type BranchSessionRequest,
  type ContextResponse,
  type CreateSessionRequest,
  type SessionListResponse,
  type SessionMessagesResponse,
  type SessionSummary,
  type TurnStatsResponse,
  type UpdateSessionRequest,
  type Usage,
} from '@ghostai/protocol';
import { toStoredMessage, type SessionSummaryRecord } from '@ghostai/core';
import { describeContext } from '@ghostai/agent';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

import {
  decodeMessageCursor,
  decodeSessionCursor,
  encodeMessageCursor,
  encodeSessionCursor,
} from '../cursor.js';
import { conflict, notFound } from '../errors.js';
import {
  PageQuerySchema,
  SessionListQuerySchema,
  SessionParamsSchema,
  TurnsQuerySchema,
  type PageQuery,
  type SessionListQuery,
  type SessionParams,
  type TurnsQuery,
} from '../queries.js';
import type { RouteDeps, RouteGroup } from './types.js';

type SessionRouteId =
  | 'sessions.list'
  | 'sessions.create'
  | 'sessions.get'
  | 'sessions.update'
  | 'sessions.delete'
  | 'sessions.messages'
  | 'sessions.clear'
  | 'sessions.context'
  | 'sessions.branch'
  | 'sessions.turns';

/**
 * `totalUsage` is omitted rather than zeroed when there is none.
 *
 * A conversation whose turns predate the `turn_stats` table has no total, and
 * reporting `0` would claim it cost nothing rather than that nobody counted.
 */
function toSummary(record: SessionSummaryRecord, totalUsage?: Usage): SessionSummary {
  return {
    key: record.key,
    title: record.title,
    messageCount: record.messageCount,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    origin: record.origin,
    workspaceId: record.workspaceId,
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    ...(totalUsage === undefined ? {} : { totalUsage }),
  };
}

export function sessionRoutes(deps: RouteDeps): RouteGroup<SessionRouteId> {
  const { store } = deps.runtime;

  /** The session, or a 404 — never an empty listing standing in for one. */
  function requireSession(key: string): SessionSummaryRecord {
    const record = store.getSession(key);
    if (record === undefined) throw notFound(`No session "${key}"`);
    return { ...record, messageCount: store.messageCount(key) };
  }

  function params(request: { params: unknown }): SessionParams {
    return request.params as SessionParams;
  }

  return {
    'sessions.list': {
      summary: 'Sessions, newest activity first',
      schema: {
        querystring: SessionListQuerySchema,
        response: { 200: SessionListResponseSchema },
      },
      handler: (request): SessionListResponse => {
        const query = request.query as SessionListQuery;
        const rows = store.listSessions({
          // One more than asked for: the extra row is what decides whether a
          // cursor is issued, and it is dropped rather than returned.
          limit: query.limit + 1,
          ...(query.origin === undefined ? {} : { origin: query.origin }),
          ...(query.workspace === undefined ? {} : { workspaceId: query.workspace }),
          ...(query.cursor === undefined ? {} : { after: decodeSessionCursor(query.cursor) }),
        });

        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        // One statement for the whole page. A per-row lookup here is the
        // difference between a listing and fifty of them.
        const usage = store.sessionUsage(page.map((record) => record.key));
        return {
          sessions: page.map((record) => toSummary(record, usage.get(record.key))),
          ...(rows.length > query.limit && last !== undefined
            ? { nextCursor: encodeSessionCursor({ updatedAtMs: last.updatedAtMs, key: last.key }) }
            : {}),
        };
      },
    },

    'sessions.create': {
      summary: 'Create a session, or return the existing one for a key',
      schema: { body: CreateSessionRequestSchema, response: { 201: SessionSummarySchema } },
      handler: (request, reply): SessionSummary => {
        const body = request.body as CreateSessionRequest;
        // `ensureSession` is idempotent, so a client that retries a create it
        // never saw the response to gets its session rather than a 409 about a
        // session it already owns.
        // The workspace has to exist before a session can be opened in one:
        // `ensureSession` would happily store any string, and a conversation
        // bound to a workspace the manager cannot list is one the UI can never
        // show the files for.
        if (
          body.workspaceId !== undefined &&
          deps.runtime.workspaces.get(body.workspaceId) === undefined
        ) {
          throw notFound(`No such workspace: ${body.workspaceId}`);
        }

        const record = store.ensureSession(body.key ?? `web-${randomUUID()}`, {
          origin: 'web',
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.workspaceId === undefined ? {} : { workspaceId: body.workspaceId }),
          ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
        });
        void reply.status(201);
        return toSummary({ ...record, messageCount: store.messageCount(record.key) });
      },
    },

    'sessions.get': {
      summary: 'One session',
      schema: { params: SessionParamsSchema, response: { 200: SessionSummarySchema } },
      handler: (request): SessionSummary => {
        const record = requireSession(params(request).key);
        return toSummary(record, store.sessionUsage([record.key]).get(record.key));
      },
    },

    'sessions.update': {
      summary: 'Rename a session or move it to another agent',
      schema: {
        params: SessionParamsSchema,
        body: UpdateSessionRequestSchema,
        response: { 200: SessionSummarySchema },
      },
      handler: (request): SessionSummary => {
        const { key } = params(request);
        requireSession(key);
        const body = request.body as UpdateSessionRequest;
        const updated = store.updateSession(key, {
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.agentId === undefined ? {} : { agentId: body.agentId }),
        });
        return toSummary({ ...updated, messageCount: store.messageCount(key) });
      },
    },

    'sessions.delete': {
      summary: 'Delete a session and its messages',
      schema: { params: SessionParamsSchema },
      handler: (request, reply): FastifyReply => {
        const { key } = params(request);
        if (!store.deleteSession(key)) throw notFound(`No session "${key}"`);
        return reply.status(204).send();
      },
    },

    'sessions.messages': {
      summary: 'A session transcript, oldest first',
      schema: {
        params: SessionParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: SessionMessagesResponseSchema },
      },
      handler: (request): SessionMessagesResponse => {
        const { key } = params(request);
        requireSession(key);
        const query = request.query as PageQuery;
        const cursor = query.cursor === undefined ? undefined : decodeMessageCursor(query.cursor);

        const rows = store.messages(key, {
          ...(cursor === undefined ? {} : { afterSeq: cursor.seq }),
          limit: query.limit + 1,
        });

        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          sessionKey: key,
          messages: page.map(toStoredMessage),
          ...(rows.length > query.limit && last !== undefined
            ? { nextCursor: encodeMessageCursor({ seq: last.seq }) }
            : {}),
        };
      },
    },

    'sessions.clear': {
      summary: 'Drop a session transcript, keeping the session',
      schema: { params: SessionParamsSchema },
      handler: (request, reply): FastifyReply => {
        const { key } = params(request);
        requireSession(key);
        store.clearMessages(key);
        return reply.status(204).send();
      },
    },

    'sessions.context': {
      summary: 'What the agent would send to the model for this session',
      schema: { params: SessionParamsSchema, response: { 200: ContextResponseSchema } },
      handler: async (request): Promise<ContextResponse> => {
        const { key } = params(request);
        const session = requireSession(key);
        // The session's own agent, not the default: its tool list, its prompt
        // and its context budget are what a turn here would actually carry, and
        // a meter measured against another agent's window is simply wrong.
        const agent = deps.runtime.agent(session.agentId);

        // The measurement itself lives in `@ghostai/agent`, so the CLI's
        // `/context` reports the same numbers from the same code rather than a
        // second implementation of the windowing rules.
        const report = await describeContext({
          store,
          loop: { previewPrompt: (input) => agent.systemPrompt(input) },
          tools: agent.tools,
          sessionKey: key,
          channel: 'web',
          ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
          contextWindowTokens: agent.contextWindowTokens,
        });
        if (report === undefined) throw notFound(`No session "${key}"`);

        return {
          sessionKey: report.sessionKey,
          systemPrompt: report.systemPrompt,
          tools: [...report.tools],
          messages: report.messages.map(toStoredMessage),
          estimatedTokens: report.estimatedTokens,
          contextWindowTokens: report.contextWindowTokens,
          breakdown: { ...report.breakdown },
        };
      },
    },

    'sessions.branch': {
      summary: 'Fork a conversation at a point into a new session',
      schema: {
        params: SessionParamsSchema,
        body: BranchSessionRequestSchema,
        response: { 201: SessionSummarySchema },
      },
      handler: (request, reply): SessionSummary => {
        const { key } = params(request);
        requireSession(key);
        const body = request.body as BranchSessionRequest;

        // Forking mid-turn would copy a question whose answer has not been
        // written yet: the loop appends an assistant turn and all of its tool
        // traffic in one transaction at the end, so a branch taken now starts
        // with an unanswered question and no way to tell that it did.
        if (deps.hub.busy(key)) {
          throw conflict('A turn is running on this conversation. Stop it, then branch.');
        }

        const fork = store.forkSession(key, body.seq, {
          ...(body.key === undefined ? {} : { key: body.key }),
          ...(body.title === undefined ? {} : { title: body.title }),
        });

        void reply.status(201);
        return toSummary(
          { ...fork.session, messageCount: fork.copied },
          store.sessionUsage([fork.session.key]).get(fork.session.key),
        );
      },
    },

    'sessions.turns': {
      summary: 'What each turn in this session cost',
      schema: {
        params: SessionParamsSchema,
        querystring: TurnsQuerySchema,
        response: { 200: TurnStatsResponseSchema },
      },
      handler: (request): TurnStatsResponse => {
        const { key } = params(request);
        requireSession(key);
        const query = request.query as TurnsQuery;
        return { sessionKey: key, turns: store.turnStats(key, { limit: query.limit }) };
      },
    },
  };
}
