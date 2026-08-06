/**
 * Sessions, messages, pagination and the context inspector.
 *
 * The pagination tests are the point of this file. Both listings are paged with
 * a keyset cursor rather than an offset, and the property that buys — a row
 * appended mid-scroll cannot make a reader see one row twice or miss another —
 * is only real if something appends mid-scroll. Two tests do.
 */

import { assistantMessage, textOf, userMessage } from '@ghostai/core';
import { ConfigSchema } from '@ghostai/protocol';
import type {
  ChatMessage,
  ContextResponse,
  SessionListResponse,
  SessionMessagesResponse,
  SessionSummary,
  TurnStatsResponse,
} from '@ghostai/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { manualClock } from '#testkit/clock.js';
import { hangingRunner } from '#testkit/hub.js';
import { startTestServer, type TestServer } from '#testkit/server.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start(
  ...args: Parameters<typeof startTestServer>
): Promise<TestServer> {
  const started = await startTestServer(...args);
  running.push(started);
  return started;
}

/** The text of each stored message, which is what the assertions are about. */
function texts(messages: Array<{ message: ChatMessage }>): string[] {
  return messages.map((stored) => textOf(stored.message));
}

interface Page {
  readonly ids: string[];
  readonly nextCursor: string | undefined;
  readonly total: number;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('sessions CRUD', () => {
  it('creates a session and returns it', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { key: 'web-1', title: 'First' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      key: 'web-1',
      title: 'First',
      messageCount: 0,
      createdAtMs: expect.any(Number),
      updatedAtMs: expect.any(Number),
      origin: 'web',
      workspaceId: 'default',
    });
  });

  it('mints a key when the client does not supply one', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: {},
    });

    expect(response.json().key).toMatch(/^[0-9a-f-]{8,}/);
  });

  // A retried create is a create whose response was lost, not a conflict.
  it('is idempotent on a repeated key', async () => {
    const { server, headers } = await start();
    const payload = { key: 'web-1', title: 'First' };
    await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload,
    });
    const second = await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload,
    });

    expect(second.statusCode).toBe(201);
    expect(second.json().key).toBe('web-1');
  });

  it('reads one session, with its message count', async () => {
    const { server, headers, runtime } = await start();
    runtime.store.append('web-1', userMessage('hello'));

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1',
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ key: 'web-1', messageCount: 1 });
  });

  it('renames a session', async () => {
    const { server, headers, runtime } = await start();
    runtime.store.ensureSession('web-1', { title: 'Old' });

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/sessions/web-1',
      headers,
      payload: { title: 'New' },
    });

    expect(response.json().title).toBe('New');
    expect(runtime.store.getSession('web-1')?.title).toBe('New');
  });

  it('moves a session to another workspace', async () => {
    const { server, headers, runtime } = await start();
    runtime.workspaces.create({ name: 'Research', id: 'research' });
    runtime.store.ensureSession('web-1', { title: 'A session' });

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/sessions/web-1',
      headers,
      payload: { workspaceId: 'research' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().workspaceId).toBe('research');
    expect(runtime.store.getSession('web-1')?.workspaceId).toBe('research');
  });

  it('refuses to move a session to a workspace that does not exist', async () => {
    // `updateSession` would store any string, and a conversation bound to a
    // workspace nothing can list is one the UI can never show the files for.
    const { server, headers, runtime } = await start();
    runtime.store.ensureSession('web-1');

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/sessions/web-1',
      headers,
      payload: { workspaceId: 'nope' },
    });

    expect(response.statusCode).toBe(404);
    expect(runtime.store.getSession('web-1')?.workspaceId).toBe('default');
  });

  it('moves a session while a turn is running on it', async () => {
    // Deliberately not refused. The loop captures its jail when the turn
    // starts, so the turn in flight finishes where it began and the next one
    // picks up the move — there is no state for a guard to protect.
    const test = await start({ runner: hangingRunner() });
    test.runtime.workspaces.create({ name: 'Research', id: 'research' });
    test.runtime.store.ensureSession('web-1');

    const client = test.hub.connect({
      send: () => undefined,
      sessionKey: 'web-1',
    });
    client.receive({
      type: 'user.message',
      sessionKey: 'web-1',
      content: 'go',
    });

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: '/api/sessions/web-1',
      headers: test.headers,
      payload: { workspaceId: 'research' },
    });

    expect(response.statusCode).toBe(200);
    expect(test.runtime.store.getSession('web-1')?.workspaceId).toBe(
      'research',
    );
    expect(test.hub.busy('web-1')).toBe(true);
  });

  it('refuses to bind a new session to an agent that does not exist', async () => {
    // Where almost every dangling binding came from: the adjacent `workspaceId`
    // was checked against the registry and this was not, so any string landed
    // in `sessions.agent_id`.
    const { server, headers } = await start();

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { key: 'web-2', agentId: 'ghost' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toMatch(/No such agent: ghost/);
  });

  it('refuses a disabled agent too, which is absent from every listing', async () => {
    const { server, headers } = await start({
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { enabled: false } } },
      }),
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { key: 'web-2', agentId: 'reviewer' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('binds a new session to an agent that does exist', async () => {
    const { server, headers, runtime } = await start({
      config: ConfigSchema.parse({
        agents: { list: { reviewer: { label: 'Reviewer' } } },
      }),
    });

    const response = await server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers,
      payload: { key: 'web-2', agentId: 'reviewer' },
    });

    expect(response.statusCode).toBe(201);
    expect(runtime.store.getSession('web-2')?.agentId).toBe('reviewer');
  });

  it('refuses to move a session onto an agent that does not exist', async () => {
    const { server, headers } = await start();

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/sessions/web-1',
      headers,
      payload: { agentId: 'ghost' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('moves a session off an agent that has been deleted', async () => {
    // The recovery path, and the reason the check is on the *incoming* id and
    // never the stored one. A conversation bound to a deleted agent has to stay
    // fixable, or the fallback becomes a state nobody can leave.
    const { server, headers, runtime } = await start({
      config: ConfigSchema.parse({
        agents: { list: { writer: { label: 'Writer' } } },
      }),
    });
    runtime.store.ensureSession('web-1', { agentId: 'reviewer' });

    const response = await server.app.inject({
      method: 'PATCH',
      url: '/api/sessions/web-1',
      headers,
      payload: { agentId: 'writer' },
    });

    expect(response.statusCode).toBe(200);
    expect(runtime.store.getSession('web-1')?.agentId).toBe('writer');
  });

  it('deletes a session and its messages', async () => {
    const { server, headers, runtime } = await start();
    runtime.store.append('web-1', userMessage('hello'));

    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/sessions/web-1',
      headers,
    });

    expect(response.statusCode).toBe(204);
    expect(runtime.store.getSession('web-1')).toBeUndefined();
  });

  it('clears a transcript but keeps the session', async () => {
    const { server, headers, runtime } = await start();
    runtime.store.append('web-1', userMessage('hello'));

    const response = await server.app.inject({
      method: 'DELETE',
      url: '/api/sessions/web-1/messages',
      headers,
    });

    expect(response.statusCode).toBe(204);
    expect(runtime.store.getSession('web-1')).toBeDefined();
    expect(runtime.store.messageCount('web-1')).toBe(0);
  });

  // A missing session is a 404 everywhere, rather than an empty listing on one
  // route and a silently created session on another.
  it.each([
    ['GET', '/api/sessions/nope'],
    ['PATCH', '/api/sessions/nope'],
    ['DELETE', '/api/sessions/nope'],
    ['GET', '/api/sessions/nope/messages'],
    ['DELETE', '/api/sessions/nope/messages'],
    ['GET', '/api/sessions/nope/context'],
  ])('answers 404 for %s %s', async (method, url) => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(method === 'PATCH' ? { payload: { title: 'x' } } : {}),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// Session pagination
// ---------------------------------------------------------------------------

describe('GET /api/sessions', () => {
  async function page(test: TestServer, query: string): Promise<Page> {
    const response = await test.server.app.inject({
      method: 'GET',
      url: `/api/sessions${query}`,
      headers: test.headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<SessionListResponse>();
    return {
      ids: body.sessions.map((session) => session.key),
      nextCursor: body.nextCursor,
      total: body.total,
    };
  }

  it('orders by most recent activity', async () => {
    const clock = manualClock();
    const test = await start({ clock });
    for (const key of ['a', 'b', 'c']) {
      test.runtime.store.append(key, userMessage(key));
      clock.advance(1000);
    }
    test.runtime.store.append('a', userMessage('again'));

    expect((await page(test, '')).ids).toEqual(['a', 'c', 'b']);
  });

  it('filters by origin', async () => {
    const test = await start();
    test.runtime.store.ensureSession('a', { origin: 'web' });
    test.runtime.store.ensureSession('b', { origin: 'telegram' });

    expect((await page(test, '?origin=telegram')).ids).toEqual(['b']);
  });

  it('issues a cursor only when there is another row', async () => {
    const test = await start();
    for (const key of ['a', 'b']) test.runtime.store.ensureSession(key);

    expect((await page(test, '?limit=1')).nextCursor).toEqual(
      expect.any(String),
    );
    expect((await page(test, '?limit=2')).nextCursor).toBeUndefined();
  });

  /**
   * The boundary test the plan asks for.
   *
   * A session is bumped to the front of the ordering between the two page
   * requests. Under offset pagination the row at the cursor position shifts by
   * one and the reader both re-sees a session and skips one; under a keyset
   * cursor the bumped session is behind the reader and everything it has not
   * seen still arrives exactly once.
   */
  it('survives an append landing between two pages', async () => {
    const clock = manualClock();
    const test = await start({ clock });
    for (const key of ['a', 'b', 'c', 'd']) {
      test.runtime.store.ensureSession(key);
      clock.advance(1000);
    }

    const first = await page(test, '?limit=2');
    // `d` was created last, so the newest-first listing starts there.
    expect(first.ids).toEqual(['d', 'c']);

    // The concurrent append: a turn lands on the oldest session, moving it to
    // the front — past the reader, which is the case that breaks an offset.
    clock.advance(1000);
    test.runtime.store.append('a', userMessage('a turn landed'));

    const second = await page(
      test,
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
    );

    const seen = [...first.ids, ...second.ids];
    // No row twice — which an offset cursor could not promise here — and `b`,
    // the one row the reader had not reached, still arrives.
    expect(new Set(seen).size).toBe(seen.length);
    expect(second.ids).toEqual(['b']);
  });

  it('rejects a cursor it did not issue', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?cursor=not-a-cursor',
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/cursor/i);
  });

  it('refuses a limit past the cap', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?limit=1000',
      headers,
    });

    expect(response.statusCode).toBe(422);
  });

  // -------------------------------------------------------------------------
  // Offset mode — the numbered pager on the sessions management screen
  // -------------------------------------------------------------------------

  it('pages over an offset, for a reader that jumps rather than walks', async () => {
    const clock = manualClock();
    const test = await start({ clock });
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      test.runtime.store.ensureSession(key);
      clock.advance(1000);
    }

    // Newest first, so page two of two is the third and fourth newest.
    expect((await page(test, '?limit=2&offset=2')).ids).toEqual(['c', 'b']);
    // Past the end is an empty page, not a wrapped one.
    expect((await page(test, '?limit=2&offset=99')).ids).toEqual([]);
  });

  it('reports the whole match, not the page in front of it', async () => {
    const test = await start();
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      test.runtime.store.ensureSession(key);
    }

    const first = await page(test, '?limit=2');
    expect(first.ids).toHaveLength(2);
    expect(first.total).toBe(5);
  });

  it('counts what it filtered, so a pager cannot outrun its own total', async () => {
    const test = await start();
    test.runtime.store.ensureSession('a', { title: 'login throttle' });
    test.runtime.store.ensureSession('b', { title: 'login rate limit' });
    test.runtime.store.ensureSession('c', { title: 'nightly digest' });

    const filtered = await page(test, '?q=login&limit=1');
    expect(filtered.ids).toHaveLength(1);
    // Not 3. A total describing the unfiltered table would offer pages that are
    // empty when reached — the "Page 4 of 3" this pairing exists to prevent.
    expect(filtered.total).toBe(2);
  });

  it('searches titles case-insensitively', async () => {
    const test = await start();
    test.runtime.store.ensureSession('a', { title: 'Fix the LOGIN throttle' });
    test.runtime.store.ensureSession('b', { title: 'Nightly digest' });

    expect((await page(test, '?q=login')).ids).toEqual(['a']);
    expect((await page(test, '?q=')).ids.sort()).toEqual(['a', 'b']);
  });

  it('orders by a column other than recency', async () => {
    const clock = manualClock();
    const test = await start({ clock });
    test.runtime.store.ensureSession('a', { title: 'Beta' });
    clock.advance(1000);
    test.runtime.store.ensureSession('b', { title: 'alpha' });

    expect((await page(test, '?sort=title&desc=false')).ids).toEqual([
      'b',
      'a',
    ]);
    expect((await page(test, '?sort=title&desc=true')).ids).toEqual(['a', 'b']);
  });

  /**
   * A cursor encodes `(updatedAtMs, key)` — a position in the default ordering
   * and in no other. Handing one back while the caller has sorted by title would
   * be handing back a cursor that cannot be followed, so under any other
   * ordering the pager gets `total` and no cursor.
   */
  it('issues no cursor under an ordering a cursor cannot address', async () => {
    const test = await start();
    for (const key of ['a', 'b']) test.runtime.store.ensureSession(key);

    expect((await page(test, '?limit=1')).nextCursor).toEqual(
      expect.any(String),
    );
    expect(
      (await page(test, '?limit=1&sort=title')).nextCursor,
    ).toBeUndefined();
    expect(
      (await page(test, '?limit=1&desc=false')).nextCursor,
    ).toBeUndefined();
  });

  /**
   * There is no reading of "page 3 relative to this position" that is more
   * correct than the others, and a precedence rule would silently ignore one of
   * the two parameters — which looks exactly like a server that paged wrongly.
   */
  it('refuses a request that names both paging modes', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?cursor=abc&offset=25',
      headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/cursor or an offset/i);
  });

  it('refuses a negative offset', async () => {
    const { server, headers } = await start();
    const response = await server.app.inject({
      method: 'GET',
      url: '/api/sessions?offset=-1',
      headers,
    });

    expect(response.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Message pagination
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:key/messages', () => {
  it('pages a transcript in order, with a concurrent append', async () => {
    const test = await start();
    for (const text of ['one', 'two', 'three']) {
      test.runtime.store.append('web-1', userMessage(text));
    }

    const first = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/messages?limit=2',
      headers: test.headers,
    });
    const firstBody = first.json<SessionMessagesResponse>();
    expect(texts(firstBody.messages)).toEqual(['one', 'two']);

    // A turn writes while the client is between pages. `seq` is monotonic and
    // append-only, so the cursor still addresses the same position.
    test.runtime.store.append('web-1', userMessage('four'));

    const second = await test.server.app.inject({
      method: 'GET',
      url: `/api/sessions/web-1/messages?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      headers: test.headers,
    });

    const secondBody = second.json<SessionMessagesResponse>();
    expect(texts(secondBody.messages)).toEqual(['three', 'four']);
    expect(secondBody.nextCursor).toBeUndefined();
  });

  it('reports why a turn failed, which the message rows cannot say', async () => {
    const test = await start();
    test.runtime.store.ensureSession('web-1');
    test.runtime.store.append('web-1', userMessage('hi'), { turnId: 't1' });
    test.runtime.store.recordTurnStats({
      turnId: 't1',
      sessionKey: 'web-1',
      agentId: 'default',
      workspaceId: 'default',
      provider: 'ollama',
      model: 'test-model',
      startedAtMs: 1,
      endedAtMs: 2,
      iterations: 0,
      stopReason: 'error',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      error: 'No container runtime is reachable.',
    });
    // A turn that succeeded contributes nothing, so the map holds failures only.
    test.runtime.store.recordTurnStats({
      turnId: 't2',
      sessionKey: 'web-1',
      agentId: 'default',
      workspaceId: 'default',
      provider: 'ollama',
      model: 'test-model',
      startedAtMs: 3,
      endedAtMs: 4,
      iterations: 1,
      stopReason: 'complete',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/messages',
      headers: test.headers,
    });

    expect(response.json<SessionMessagesResponse>().failures).toEqual({
      t1: 'No container runtime is reachable.',
    });
  });

  it('returns an empty page for a session with no messages', async () => {
    const test = await start();
    test.runtime.store.ensureSession('web-1');

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/messages',
      headers: test.headers,
    });

    expect(response.json()).toEqual({
      sessionKey: 'web-1',
      messages: [],
      subagentRuns: {},
      failures: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

describe('GET /api/sessions/:key/context', () => {
  it('reports the prompt, the window and where the tokens went', async () => {
    const test = await start({ systemPrompt: 'SYSTEM PROMPT' });
    test.runtime.store.append('web-1', userMessage('hello'));
    test.runtime.store.append('web-1', assistantMessage('hi'));

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/context',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ContextResponse>();
    expect(body.sessionKey).toBe('web-1');
    expect(body.systemPrompt).toBe('SYSTEM PROMPT');
    expect(body.messages).toHaveLength(2);
    // Stored messages, so each one carries the id the transcript uses — which is
    // what lets the inspector point at a row rather than describe it.
    expect(body.messages[0]).toMatchObject({
      id: expect.any(String),
      sessionKey: 'web-1',
    });
    expect(body.contextWindowTokens).toBe(65_536);
    expect(body.estimatedTokens).toBe(
      Object.values(body.breakdown).reduce(
        (total, tokens) => total + tokens,
        0,
      ),
    );
    // The trailing turn, reported apart from the system prompt because it is the
    // only section billed again on every step. Asserted on the wire and not just
    // in `describeContext`: a field missing from the route's response schema is
    // stripped during serialisation, silently and with the handler none the wiser.
    expect(body.runtimeBlock).toContain('Live state');
    expect(body.breakdown.runtimeBlock).toBeGreaterThan(0);
  });

  /**
   * The window is `historyForLLM`'s, not a second implementation of it.
   *
   * A transcript that opens on an orphaned `tool` result is the case every
   * provider rejects with a 400, and the inspector has to show the repaired
   * window rather than the raw rows — otherwise it describes a request that
   * would never be sent.
   */
  it('shows the repaired window rather than the raw rows', async () => {
    const test = await start();
    test.runtime.store.appendMany('web-1', [
      {
        role: 'tool',
        content: 'orphaned',
        toolCallId: 'call-1',
        name: 'read_file',
      },
      userMessage('hello'),
    ]);

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/context',
      headers: test.headers,
    });

    const body = response.json<ContextResponse>();
    expect(body.messages.map((stored) => stored.message.role)).toEqual([
      'user',
    ]);
  });

  it('names the agent it measured, and says nothing was substituted', async () => {
    const test = await start();
    test.runtime.store.ensureSession('web-1');
    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/context',
      headers: test.headers,
    });

    const body = response.json<ContextResponse>();
    expect(body.agentId).toBe('default');
    // Absent is the healthy state, so presence alone is the whole signal.
    expect(body.requestedAgentId).toBeUndefined();
  });

  it('measures the default agent rather than 404ing for a binding that is gone', async () => {
    // The panel used to 404 for a conversation that lists and opens perfectly
    // well, and blamed the session for it.
    const test = await start();
    test.runtime.store.ensureSession('web-1', { agentId: 'reviewer' });

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/context',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<ContextResponse>();
    expect(body.agentId).toBe('default');
    expect(body.requestedAgentId).toBe('reviewer');
  });
});

// ---------------------------------------------------------------------------
// Branching
// ---------------------------------------------------------------------------

describe('branching a session', () => {
  it('forks the prefix into a new session and leaves the source alone', async () => {
    const test = await start();
    test.runtime.store.append('web-1', userMessage('one'));
    test.runtime.store.append('web-1', assistantMessage('two'));
    test.runtime.store.append('web-1', userMessage('three'));

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions/web-1/branch',
      headers: test.headers,
      payload: { seq: 2 },
    });

    expect(response.statusCode).toBe(201);
    const fork = response.json<SessionSummary>();
    expect(fork.messageCount).toBe(2);
    expect(fork.key).not.toBe('web-1');
    expect(texts(test.runtime.store.messages(fork.key))).toEqual([
      'one',
      'two',
    ]);
    expect(test.runtime.store.messageCount('web-1')).toBe(3);
  });

  it('honours a title and a key', async () => {
    const test = await start();
    test.runtime.store.append('web-1', userMessage('one'));

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions/web-1/branch',
      headers: test.headers,
      payload: { seq: 1, key: 'chosen', title: 'A fork' },
    });

    expect(response.json<SessionSummary>()).toMatchObject({
      key: 'chosen',
      title: 'A fork',
    });
  });

  it('reports a cut that had to snap to a legal boundary', async () => {
    const test = await start();
    test.runtime.store.append('web-1', userMessage('read it'));
    test.runtime.store.append('web-1', {
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'a', name: 'read_file', argumentsJson: '{}' }],
    });
    test.runtime.store.append('web-1', {
      role: 'tool',
      toolCallId: 'a',
      name: 'read_file',
      content: 'contents',
    });

    // Cutting at 2 would strand the assistant's unanswered call.
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions/web-1/branch',
      headers: test.headers,
      payload: { seq: 2 },
    });

    expect(response.json<SessionSummary>().messageCount).toBe(1);
  });

  it('404s for a session that does not exist', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions/nope/branch',
      headers: test.headers,
      payload: { seq: 1 },
    });

    expect(response.statusCode).toBe(404);
  });

  it('409s while a turn is running on the source', async () => {
    const test = await start({ runner: hangingRunner() });
    test.runtime.store.append('web-1', userMessage('one'));

    const client = test.hub.connect({
      send: () => undefined,
      sessionKey: 'web-1',
    });
    client.receive({
      type: 'user.message',
      sessionKey: 'web-1',
      content: 'go',
    });

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions/web-1/branch',
      headers: test.headers,
      payload: { seq: 1 },
    });

    // The loop appends a turn's whole output at the end, so a fork taken now
    // would start with a question nothing has answered.
    expect(response.statusCode).toBe(409);
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Turn stats
// ---------------------------------------------------------------------------

describe('turn stats', () => {
  const stats = (turnId: string, endedAtMs: number) => ({
    turnId,
    sessionKey: 'web-1',
    agentId: 'default',
    workspaceId: 'default',
    provider: 'anthropic',
    model: 'claude-opus-5',
    startedAtMs: 1000,
    endedAtMs,
    iterations: 2,
    stopReason: 'complete' as const,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  });

  it('returns an empty list for a conversation with no recorded turns', async () => {
    const test = await start();
    test.runtime.store.ensureSession('web-1');

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/turns',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<TurnStatsResponse>()).toEqual({
      sessionKey: 'web-1',
      turns: [],
    });
  });

  it('returns the recorded turns, newest first', async () => {
    const test = await start();
    test.runtime.store.ensureSession('web-1');
    test.runtime.store.recordTurnStats(stats('t1', 2000));
    test.runtime.store.recordTurnStats(stats('t2', 3000));

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1/turns',
      headers: test.headers,
    });

    const body = response.json<TurnStatsResponse>();
    expect(body.turns.map((turn) => turn.turnId)).toEqual(['t2', 't1']);
    expect(body.turns[0]?.usage.totalTokens).toBe(120);
  });

  it('404s for a session that does not exist', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/nope/turns',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(404);
  });

  it('reports a session total the listing can show', async () => {
    const test = await start();
    test.runtime.store.ensureSession('web-1');
    test.runtime.store.recordTurnStats(stats('t1', 2000));
    test.runtime.store.recordTurnStats(stats('t2', 3000));

    const listed = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: test.headers,
    });
    const one = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1',
      headers: test.headers,
    });

    expect(
      listed.json<SessionListResponse>().sessions[0]?.totalUsage?.totalTokens,
    ).toBe(240);
    expect(one.json<SessionSummary>().totalUsage?.totalTokens).toBe(240);
  });

  it('omits the total for a conversation whose turns predate the table', async () => {
    const test = await start();
    test.runtime.store.append('web-1', userMessage('hello'));

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/sessions/web-1',
      headers: test.headers,
    });

    // Absent rather than zero: nobody counted, which is not the same as free.
    expect(response.json<SessionSummary>().totalUsage).toBeUndefined();
  });
});
