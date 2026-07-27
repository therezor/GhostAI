import { describe, expect, it } from 'vitest';

import {
  decodeMessageCursor,
  decodeNotificationCursor,
  decodeSessionCursor,
  encodeMessageCursor,
  encodeNotificationCursor,
  encodeSessionCursor,
} from './cursor.js';

describe('cursors', () => {
  it('round-trips a message position', () => {
    expect(decodeMessageCursor(encodeMessageCursor({ seq: 42 }))).toEqual({ seq: 42 });
  });

  it('round-trips a session position', () => {
    const cursor = { updatedAtMs: 1_700_000_000_000, key: 'web-1' };
    expect(decodeSessionCursor(encodeSessionCursor(cursor))).toEqual(cursor);
  });

  it('round-trips a notification position', () => {
    const cursor = { createdAtMs: 1_700_000_000_000, id: 'n1' };
    expect(decodeNotificationCursor(encodeNotificationCursor(cursor))).toEqual(cursor);
  });

  // Opaque on purpose: a cursor that reads as `42` is a cursor a client does
  // arithmetic on, and then the server can never change what one addresses.
  it('does not look like the value it carries', () => {
    expect(encodeMessageCursor({ seq: 42 })).not.toContain('42');
  });

  it.each([
    ['not base64 at all', '@@@@'],
    ['base64 that is not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['JSON that is not an object', Buffer.from('[1,2]', 'utf8').toString('base64url')],
    ['an object with the wrong field', Buffer.from('{"x":1}', 'utf8').toString('base64url')],
    ['a seq that is not an integer', Buffer.from('{"s":1.5}', 'utf8').toString('base64url')],
  ])('refuses %s with a 400', (_name, cursor) => {
    // Never a silent restart from the top: that pages a client through the same
    // first page forever, which reads as a hung UI rather than a bad request.
    expect(() => decodeMessageCursor(cursor)).toThrow(/cursor/i);
  });

  it('refuses a session cursor missing its key', () => {
    const cursor = Buffer.from('{"u":1}', 'utf8').toString('base64url');
    expect(() => decodeSessionCursor(cursor)).toThrow(/cursor/i);
  });

  it('refuses a notification cursor missing its id', () => {
    const cursor = Buffer.from('{"c":1}', 'utf8').toString('base64url');
    expect(() => decodeNotificationCursor(cursor)).toThrow(/cursor/i);
  });

  it('refuses a cursor for the wrong listing', () => {
    // A message cursor handed to the session listing decodes as base64 and as
    // JSON and still does not address a position. It has to be rejected on its
    // fields, not on its encoding.
    expect(() => decodeSessionCursor(encodeMessageCursor({ seq: 1 }))).toThrow(/cursor/i);
  });
});
