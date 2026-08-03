/**
 * The query schemas, and the one thing that would make them a liability:
 * drifting from the protocol shape they restate.
 */

import { PaginationQuerySchema } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  NotificationListQuerySchema,
  OptionalPathQuerySchema,
  PageQuerySchema,
  PathQuerySchema,
  SessionListQuerySchema,
} from '#src/queries.js';

describe('PageQuerySchema', () => {
  it('coerces the string a query string actually carries', () => {
    expect(PageQuerySchema.parse({ limit: '25' })).toEqual({ limit: 25 });
  });

  it('defaults the limit when none is given', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_LIMIT });
  });

  it.each(['0', '-1', '1.5', 'lots', String(MAX_PAGE_LIMIT + 1)])(
    'refuses limit=%s',
    (limit) => {
      expect(PageQuerySchema.safeParse({ limit }).success).toBe(false);
    },
  );

  /**
   * The reason these schemas are allowed to exist twice.
   *
   * `@ghostai/protocol` states what a client sends and forbids transforms, so it
   * cannot coerce; this states the same shape as it arrives. If the two ever
   * disagree about the default or the cap, the document generated from one
   * describes a server that enforces the other.
   */
  it('agrees with the protocol about the bounds', () => {
    const fromProtocol = PaginationQuerySchema.parse({});
    expect(fromProtocol.limit).toBe(DEFAULT_PAGE_LIMIT);
    expect(
      PaginationQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT }).success,
    ).toBe(true);
    expect(
      PaginationQuerySchema.safeParse({ limit: MAX_PAGE_LIMIT + 1 }).success,
    ).toBe(false);
  });

  it('coerces an offset the same way', () => {
    expect(PageQuerySchema.parse({ offset: '50' })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      offset: 50,
    });
    expect(PageQuerySchema.parse({ offset: '0' })).toMatchObject({ offset: 0 });
  });

  /**
   * The distinction the paging guard rests on.
   *
   * `assertOnePagingMode` refuses a request carrying both a cursor and an
   * offset, so "offset 0" and "no offset" have to stay different values — a
   * schema that defaulted this to `0` would make every cursor request arrive
   * carrying an offset it never sent, and the guard would reject all of them.
   */
  it('leaves an absent offset absent rather than defaulting it to zero', () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_LIMIT });
    expect(PageQuerySchema.parse({ cursor: 'abc' })).not.toHaveProperty(
      'offset',
    );
  });

  it.each(['-1', '1.5', 'lots'])('refuses offset=%s', (offset) => {
    expect(PageQuerySchema.safeParse({ offset }).success).toBe(false);
  });
});

describe('SessionListQuerySchema', () => {
  it('carries an optional origin filter', () => {
    expect(SessionListQuerySchema.parse({ origin: 'telegram' })).toEqual({
      limit: DEFAULT_PAGE_LIMIT,
      origin: 'telegram',
    });
  });

  it('refuses an empty origin, which would filter to nothing', () => {
    expect(SessionListQuerySchema.safeParse({ origin: '' }).success).toBe(
      false,
    );
  });

  /**
   * Unlike `origin`, and deliberately: an empty search box is a legal thing for
   * a client to send, and the store already reads blank as "no filter".
   * Rejecting it would turn clearing the field into a 400.
   */
  it('accepts an empty search, because a cleared box is not a bad request', () => {
    expect(SessionListQuerySchema.parse({ q: '' })).toMatchObject({ q: '' });
  });

  it.each(['updated', 'created', 'title'])('takes sort=%s', (sort) => {
    expect(SessionListQuerySchema.parse({ sort })).toMatchObject({ sort });
  });

  it('refuses a column it cannot order by', () => {
    // `messages` in particular: the count is a correlated subquery, so ordering
    // by it would scan the messages table once per session row.
    expect(SessionListQuerySchema.safeParse({ sort: 'messages' }).success).toBe(
      false,
    );
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('reads desc=%s as a boolean', (input, expected) => {
    expect(SessionListQuerySchema.parse({ desc: input })).toMatchObject({
      desc: expected,
    });
  });

  it('refuses a direction that is neither', () => {
    expect(SessionListQuerySchema.safeParse({ desc: 'maybe' }).success).toBe(
      false,
    );
  });
});

describe('NotificationListQuerySchema', () => {
  it.each([
    ['true', true],
    ['false', false],
  ])('reads unread=%s as a boolean', (input, expected) => {
    expect(NotificationListQuerySchema.parse({ unread: input })).toMatchObject({
      unread: expected,
    });
  });

  // Not "anything that is not `false`": `unread=maybe` is a client bug, and
  // answering it with the full list hides the bug behind a plausible response.
  it('refuses a value that is neither', () => {
    expect(
      NotificationListQuerySchema.safeParse({ unread: 'maybe' }).success,
    ).toBe(false);
  });
});

describe('path queries', () => {
  it('requires a path where one is the subject of the request', () => {
    expect(PathQuerySchema.safeParse({}).success).toBe(false);
    expect(PathQuerySchema.parse({ path: 'notes/todo.md' })).toEqual({
      path: 'notes/todo.md',
      workspace: 'default',
    });
  });

  it('defaults a listing to the workspace root', () => {
    expect(OptionalPathQuerySchema.parse({})).toEqual({
      path: '.',
      workspace: 'default',
    });
  });
});
