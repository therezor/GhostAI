/**
 * The notification routes, and the store underneath them.
 *
 * Both in one file: the store has no consumer other than these four routes, and
 * splitting them would mean two files that fail together.
 */

import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { NotificationListResponse } from '@ghostbot/protocol';

import { NotificationStore } from '#src/notifications.js';
import { manualClock } from '#testkit/clock.js';
import { startTestServer, type TestServer } from '#testkit/server.js';

const running: TestServer[] = [];
const opened: DatabaseSync[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
  while (opened.length > 0) opened.pop()?.close();
});

async function start(
  ...args: Parameters<typeof startTestServer>
): Promise<TestServer> {
  const started = await startTestServer(...args);
  running.push(started);
  return started;
}

function titles(body: NotificationListResponse): string[] {
  return body.notifications.map((notification) => notification.title);
}

function store(clock = manualClock()): NotificationStore {
  const database = new DatabaseSync(':memory:');
  opened.push(database);
  let counter = 0;
  return new NotificationStore({
    database,
    clock,
    newId: () => `n${String(++counter).padStart(3, '0')}`,
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('NotificationStore', () => {
  it('creates unread and counts what is waiting', async () => {
    const clock = manualClock();
    const notifications = store(clock);
    notifications.create({ title: 'Job finished' });
    clock.advance(1000);
    notifications.create({
      title: 'Job failed',
      level: 'error',
      jobId: 'job-1',
    });

    expect(notifications.unreadCount()).toBe(2);
    expect(notifications.list()[0]).toMatchObject({
      title: 'Job failed',
      level: 'error',
      jobId: 'job-1',
    });
  });

  // "When did this stop being new" is a question a badge asks, and a boolean
  // cannot answer it.
  it('records when a notification was read, once', async () => {
    const clock = manualClock();
    const notifications = store(clock);
    const created = notifications.create({ title: 'Job finished' });

    clock.advance(5000);
    const first = notifications.markRead(created.id);
    clock.advance(5000);
    const second = notifications.markRead(created.id);

    expect(first?.readAtMs).toBe(second?.readAtMs);
    expect(notifications.unreadCount()).toBe(0);
  });

  it('pages newest first, breaking a tie by id', async () => {
    const clock = manualClock();
    const notifications = store(clock);
    // Same millisecond: an automation run finishing several jobs at once, which
    // is exactly the tie the cursor's second column exists for.
    const first = notifications.create({ title: 'one' });
    const second = notifications.create({ title: 'two' });
    clock.advance(1000);
    const third = notifications.create({ title: 'three' });

    const page = notifications.list({ limit: 2 });
    expect(page.map((entry) => entry.id)).toEqual([third.id, first.id]);

    const rest = notifications.list({
      limit: 2,
      after: { createdAtMs: first.createdAtMs, id: first.id },
    });
    expect(rest.map((entry) => entry.id)).toEqual([second.id]);
  });

  it('counts the whole table, and the unread within it, separately', async () => {
    const test = await start();
    const first = test.server.notifications.create({ title: 'one' });
    test.server.notifications.create({ title: 'two' });
    test.server.notifications.markRead(first.id);

    expect(test.server.notifications.count()).toBe(2);
    expect(test.server.notifications.count({ unreadOnly: true })).toBe(1);
    expect(test.server.notifications.unreadCount()).toBe(1);
  });

  it('pages over an offset for a numbered reader', async () => {
    const test = await start();
    for (let i = 0; i < 5; i += 1) {
      test.server.notifications.create({ title: `n${String(i)}` });
    }

    expect(
      test.server.notifications.list({ limit: 2, offset: 2 }),
    ).toHaveLength(2);
    expect(test.server.notifications.list({ limit: 2, offset: 99 })).toEqual(
      [],
    );
  });

  it('empties the table and says how many went', async () => {
    const test = await start();
    for (let i = 0; i < 3; i += 1) {
      test.server.notifications.create({ title: `n${String(i)}` });
    }

    expect(test.server.notifications.deleteAll()).toBe(3);
    expect(test.server.notifications.count()).toBe(0);
    // A second clear removes nothing rather than failing.
    expect(test.server.notifications.deleteAll()).toBe(0);
  });

  it('filters to unread', async () => {
    const notifications = store();
    const read = notifications.create({ title: 'read' });
    notifications.create({ title: 'unread' });
    notifications.markRead(read.id);

    expect(
      notifications.list({ unreadOnly: true }).map((entry) => entry.title),
    ).toEqual(['unread']);
  });

  it('reports nothing for an id it does not hold', async () => {
    const notifications = store();
    expect(notifications.markRead('nope')).toBeUndefined();
    expect(notifications.delete('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe('notification routes', () => {
  it('lists with the total unread count, not the page count', async () => {
    const test = await start();
    for (let i = 0; i < 3; i += 1) {
      test.server.notifications.create({ title: `n${String(i)}` });
    }

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=1',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().notifications).toHaveLength(1);
    expect(response.json().unreadCount).toBe(3);
    expect(response.json().nextCursor).toEqual(expect.any(String));
  });

  it('pages with the cursor it issued', async () => {
    const clock = manualClock();
    const test = await start({ clock });
    for (const title of ['first', 'second', 'third']) {
      test.server.notifications.create({ title });
      clock.advance(1000);
    }

    const first = await test.server.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=2',
      headers: test.headers,
    });
    const second = await test.server.app.inject({
      method: 'GET',
      url: `/api/notifications?limit=2&cursor=${encodeURIComponent(first.json().nextCursor)}`,
      headers: test.headers,
    });

    expect(titles(first.json())).toEqual(['third', 'second']);
    expect(titles(second.json())).toEqual(['first']);
    expect(second.json().nextCursor).toBeUndefined();
  });

  it('filters to unread over the wire', async () => {
    const test = await start();
    const read = test.server.notifications.create({ title: 'read' });
    test.server.notifications.create({ title: 'unread' });
    test.server.notifications.markRead(read.id);

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/notifications?unread=true',
      headers: test.headers,
    });

    expect(titles(response.json())).toEqual(['unread']);
  });

  it('marks one read and returns the updated row', async () => {
    const test = await start();
    const created = test.server.notifications.create({ title: 'Job finished' });

    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/notifications/${created.id}/read`,
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      readAtMs: expect.any(Number),
    });
    expect(test.server.notifications.unreadCount()).toBe(0);
  });

  it('marks everything read', async () => {
    const test = await start();
    test.server.notifications.create({ title: 'one' });
    test.server.notifications.create({ title: 'two' });

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
    expect(test.server.notifications.unreadCount()).toBe(0);
  });

  it('deletes one', async () => {
    const test = await start();
    const created = test.server.notifications.create({ title: 'one' });

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: `/api/notifications/${created.id}`,
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
    expect(test.server.notifications.get(created.id)).toBeUndefined();
  });

  it('pages over an offset and reports how many there are', async () => {
    const test = await start();
    for (let i = 0; i < 5; i += 1) {
      test.server.notifications.create({ title: `n${String(i)}` });
    }

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/notifications?limit=2&offset=2',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<NotificationListResponse>();
    expect(body.notifications).toHaveLength(2);
    expect(body.total).toBe(5);
  });

  /**
   * `total` and `unreadCount` are two questions, and conflating them is how a
   * list of 200 read notifications reports that it has none. The badge counts
   * what is waiting; the pager counts what it is paging through.
   */
  it('separates how many there are from how many are unread', async () => {
    const test = await start();
    const first = test.server.notifications.create({ title: 'one' });
    test.server.notifications.create({ title: 'two' });
    test.server.notifications.markRead(first.id);

    const all = (
      await test.server.app.inject({
        method: 'GET',
        url: '/api/notifications',
        headers: test.headers,
      })
    ).json<NotificationListResponse>();
    expect(all).toMatchObject({ total: 2, unreadCount: 1 });

    // With the filter on, the two agree — the rows being paged *are* the unread.
    const unread = (
      await test.server.app.inject({
        method: 'GET',
        url: '/api/notifications?unread=true',
        headers: test.headers,
      })
    ).json<NotificationListResponse>();
    expect(unread).toMatchObject({ total: 1, unreadCount: 1 });
  });

  it('refuses a request that names both paging modes', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/notifications?cursor=abc&offset=25',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/cursor or an offset/i);
  });

  /**
   * Read *and* unread. A clear-all that quietly kept the unread ones would
   * leave the bell still counting after the list looked empty.
   */
  it('clears everything, read and unread alike', async () => {
    const test = await start();
    const first = test.server.notifications.create({ title: 'read one' });
    test.server.notifications.create({ title: 'still unread' });
    test.server.notifications.markRead(first.id);

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/notifications',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
    expect(test.server.notifications.count()).toBe(0);
    expect(test.server.notifications.unreadCount()).toBe(0);
  });

  /** An empty table is not an error — clearing nothing is a no-op, not a 404. */
  it('clears an empty list without complaint', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/notifications',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
  });

  it.each([
    ['POST', '/api/notifications/nope/read'],
    ['DELETE', '/api/notifications/nope'],
  ])('answers 404 for %s %s', async (method, url) => {
    const test = await start();
    const response = await test.server.app.inject({
      method: method as 'POST',
      url,
      headers: test.headers,
    });

    expect(response.statusCode).toBe(404);
  });

  // `/read` is a static segment and `/:id/read` a parameterised one. If the
  // router preferred the parameter, marking everything read would try to read a
  // notification called "read".
  it('routes mark-all ahead of the id parameter', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
  });
});
