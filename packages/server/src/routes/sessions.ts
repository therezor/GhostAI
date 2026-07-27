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
  ContextResponseSchema,
  CreateSessionRequestSchema,
  SessionListResponseSchema,
  SessionMessagesResponseSchema,
  SessionSummarySchema,
  UpdateSessionRequestSchema,
  type ContextResponse,
  type CreateSessionRequest,
  type SessionListResponse,
  type SessionMessagesResponse,
  type SessionSummary,
  type StoredMessage,
  type UpdateSessionRequest,
} from '@ghostai/protocol';
import {
  historyForLLM,
  toStoredMessage,
  type SessionSummaryRecord,
  type StoredMessageRecord,
} from '@ghostai/core';
import { estimateTokens } from '@ghostai/providers';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';

import {
  decodeMessageCursor,
  decodeSessionCursor,
  encodeMessageCursor,
  encodeSessionCursor,
} from '../cursor.js';
import { notFound } from '../errors.js';
import {
  PageQuerySchema,
  SessionListQuerySchema,
  SessionParamsSchema,
  type PageQuery,
  type SessionListQuery,
  type SessionParams,
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
  | 'sessions.context';

function toSummary(record: SessionSummaryRecord): SessionSummary {
  return {
    key: record.key,
    title: record.title,
    messageCount: record.messageCount,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    origin: record.origin,
    ...(record.profileId === undefined ? {} : { profileId: record.profileId }),
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
          ...(query.cursor === undefined ? {} : { after: decodeSessionCursor(query.cursor) }),
        });

        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          sessions: page.map(toSummary),
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
        const record = store.ensureSession(body.key ?? `web-${randomUUID()}`, {
          origin: 'web',
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.profileId === undefined ? {} : { profileId: body.profileId }),
        });
        void reply.status(201);
        return toSummary({ ...record, messageCount: store.messageCount(record.key) });
      },
    },

    'sessions.get': {
      summary: 'One session',
      schema: { params: SessionParamsSchema, response: { 200: SessionSummarySchema } },
      handler: (request): SessionSummary => toSummary(requireSession(params(request).key)),
    },

    'sessions.update': {
      summary: 'Rename a session or move it to another profile',
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
          ...(body.profileId === undefined ? {} : { profileId: body.profileId }),
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
        const agent = deps.runtime.agent();

        // Read the same window the loop reads — everything past the
        // consolidation marker — and hand it to the same function, so what is
        // shown is what would be sent rather than an approximation of it.
        const records = store.messages(key, { afterSeq: session.lastConsolidatedSeq });
        const byMessage = new Map<unknown, StoredMessageRecord>(
          records.map((record) => [record.message, record]),
        );
        // `maxToolResultChars: 0` disables truncation, which is what makes the
        // returned messages the *same objects* that went in — and that identity
        // is how each one is matched back to the stored row carrying its id.
        const window = historyForLLM(
          records.map((record) => record.message),
          { maxToolResultChars: 0 },
        );

        const messages: StoredMessage[] = [];
        for (const message of window) {
          const record = byMessage.get(message);
          if (record !== undefined) messages.push(toStoredMessage(record));
        }

        const systemPrompt = await agent.systemPrompt({ sessionKey: key, channel: 'web' });
        const promptTokens = estimateTokens(systemPrompt);
        const toolTokens = estimateTokens(JSON.stringify(agent.tools));
        const messageTokens = window.reduce(
          (total, message) => total + estimateTokens(JSON.stringify(message)),
          0,
        );

        return {
          sessionKey: key,
          systemPrompt,
          messages,
          estimatedTokens: promptTokens + toolTokens + messageTokens,
          contextWindowTokens: deps.runtime.config().agents.defaults.contextWindowTokens,
          // Named sections rather than a single number, because the question
          // this panel exists to answer is *which* block got too big.
          breakdown: {
            systemPrompt: promptTokens,
            tools: toolTokens,
            messages: messageTokens,
          },
        };
      },
    },
  };
}
