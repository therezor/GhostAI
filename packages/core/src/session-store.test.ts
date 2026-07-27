import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { GhostError, isGhostError } from './errors.js';
import { hasOrphanedToolResult } from './history.js';
import { assistantMessage, toolMessage, userMessage } from './messages.js';
import { SessionStore, toStoredMessage } from './session-store.js';

const NOW = 1_700_000_000_000;

/** Wall clock frozen, monotonic frozen — nothing here measures a duration. */
const fixedClock: Clock = {
  now: () => NOW,
  monotonic: () => 0,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
  sleep: () => Promise.resolve(),
};

/**
 * Deterministic ids. The prefix distinguishes two stores over the same file —
 * production uses `randomUUID`, so only a fixture can collide this way.
 */
function counterIds(prefix = 'm'): () => string {
  let n = 0;
  return () => `${prefix}${String(++n)}`;
}

const tempDirs: string[] = [];

function tempFile(name = 'ghost.db'): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-core-'));
  tempDirs.push(dir);
  return join(dir, name);
}

function makeStore(): SessionStore {
  return new SessionStore({ clock: fixedClock, newId: counterIds() });
}

const call = (id: string): { id: string; name: string; argumentsJson: string } => ({
  id,
  name: 'read_file',
  argumentsJson: '{"path":"a.txt"}',
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('sessions', () => {
  it('creates a session on demand with defaults', () => {
    const store = makeStore();
    const session = store.ensureSession('web:1');

    expect(session).toMatchObject({
      key: 'web:1',
      title: '',
      origin: 'web',
      profileId: undefined,
      createdAtMs: NOW,
      lastConsolidatedSeq: 0,
      lastLearnedSeq: 0,
      metadata: {},
    });
    store.close();
  });

  it('is idempotent and does not overwrite an existing session', () => {
    const store = makeStore();
    store.ensureSession('web:1', { title: 'First', origin: 'telegram' });
    const again = store.ensureSession('web:1', { title: 'Second' });

    expect(again.title).toBe('First');
    expect(again.origin).toBe('telegram');
    store.close();
  });

  it('rejects an empty session key', () => {
    const store = makeStore();
    expect(() => store.ensureSession('')).toThrow(GhostError);
    store.close();
  });

  it('returns undefined for a session that does not exist', () => {
    const store = makeStore();
    expect(store.getSession('nope')).toBeUndefined();
    store.close();
  });

  it('lists sessions newest first with message counts', () => {
    const store = makeStore();
    store.ensureSession('a');
    store.ensureSession('b');
    store.append('b', userMessage('hi'));

    const listed = store.listSessions();
    expect(listed).toHaveLength(2);
    expect(listed.find((s) => s.key === 'b')?.messageCount).toBe(1);
    expect(listed.find((s) => s.key === 'a')?.messageCount).toBe(0);
    store.close();
  });

  it('filters the listing by origin', () => {
    const store = makeStore();
    store.ensureSession('a', { origin: 'web' });
    store.ensureSession('t', { origin: 'telegram' });

    expect(store.listSessions({ origin: 'telegram' }).map((s) => s.key)).toEqual(['t']);
    expect(
      store
        .listSessions()
        .map((s) => s.key)
        .sort(),
    ).toEqual(['a', 't']);
    store.close();
  });

  it('paginates the listing', () => {
    const store = makeStore();
    store.ensureSession('a');
    store.ensureSession('b');
    store.ensureSession('c');

    expect(store.listSessions({ limit: 2 })).toHaveLength(2);
    expect(store.listSessions({ limit: 2, offset: 2 })).toHaveLength(1);
    store.close();
  });

  it('resumes a listing from a keyset cursor', () => {
    let now = NOW;
    const store = new SessionStore({
      clock: { ...fixedClock, now: () => now },
      newId: counterIds(),
    });
    for (const key of ['a', 'b', 'c']) {
      store.ensureSession(key);
      now += 1000;
    }

    // Newest first, so the listing runs c, b, a.
    const [first] = store.listSessions({ limit: 1 });
    const rest = store.listSessions({
      after: { updatedAtMs: first?.updatedAtMs ?? 0, key: first?.key ?? '' },
    });

    expect(first?.key).toBe('c');
    expect(rest.map((session) => session.key)).toEqual(['b', 'a']);
    store.close();
  });

  /**
   * The property the cursor exists for, and the one an offset cannot hold: a
   * turn landing between two pages moves a session to the front, which shifts
   * every offset behind it and makes a reader see one row twice.
   */
  it('does not repeat a row when an append reorders the listing', () => {
    let now = NOW;
    const store = new SessionStore({
      clock: { ...fixedClock, now: () => now },
      newId: counterIds(),
    });
    for (const key of ['a', 'b', 'c']) {
      store.ensureSession(key);
      now += 1000;
    }

    const page = store.listSessions({ limit: 1 });
    const cursor = { updatedAtMs: page[0]?.updatedAtMs ?? 0, key: page[0]?.key ?? '' };

    now += 1000;
    store.append('a', userMessage('a turn landed'));

    const next = store.listSessions({ after: cursor });
    // `a` jumped ahead of the cursor and is not served twice; `b`, which the
    // reader had not reached, still arrives.
    expect(next.map((session) => session.key)).toEqual(['b']);
    store.close();
  });

  it('breaks a timestamp tie by key, in one direction only', () => {
    const store = makeStore();
    for (const key of ['a', 'b', 'c']) store.ensureSession(key);

    // Every row shares `NOW`, so the whole ordering rests on the key column.
    const first = store.listSessions({ limit: 1 });
    expect(first[0]?.key).toBe('a');

    const rest = store.listSessions({ after: { updatedAtMs: NOW, key: 'a' } });
    expect(rest.map((session) => session.key)).toEqual(['b', 'c']);
    store.close();
  });

  it('patches only the fields it is given', () => {
    const store = makeStore();
    store.ensureSession('a', { title: 'Title', profileId: 'p1' });

    const updated = store.updateSession('a', { lastConsolidatedSeq: 4 });
    expect(updated.title).toBe('Title');
    expect(updated.profileId).toBe('p1');
    expect(updated.lastConsolidatedSeq).toBe(4);
    store.close();
  });

  it('distinguishes clearing a profile from leaving it alone', () => {
    const store = makeStore();
    store.ensureSession('a', { profileId: 'p1' });

    expect(store.updateSession('a', { title: 'x' }).profileId).toBe('p1');
    expect(store.updateSession('a', { profileId: null }).profileId).toBeUndefined();
    expect(store.getSession('a')?.profileId).toBeUndefined();
    store.close();
  });

  it('round-trips metadata', () => {
    const store = makeStore();
    store.ensureSession('a', { metadata: { topicId: 42 } });
    expect(store.getSession('a')?.metadata).toEqual({ topicId: 42 });

    store.updateSession('a', { metadata: { topicId: 43, tags: ['x'] } });
    expect(store.getSession('a')?.metadata).toEqual({ topicId: 43, tags: ['x'] });
    store.close();
  });

  it('deletes a session and cascades to its messages', () => {
    const store = makeStore();
    store.append('a', userMessage('hi'));

    expect(store.deleteSession('a')).toBe(true);
    expect(store.getSession('a')).toBeUndefined();
    expect(store.messageCount('a')).toBe(0);
    expect(store.deleteSession('a')).toBe(false);
    store.close();
  });
});

describe('appending', () => {
  it('assigns contiguous sequence numbers from one', () => {
    const store = makeStore();
    expect(store.append('s', userMessage('one')).seq).toBe(1);
    expect(store.append('s', assistantMessage('two')).seq).toBe(2);
    expect(store.append('s', userMessage('three')).seq).toBe(3);
    store.close();
  });

  it('creates the session implicitly', () => {
    const store = makeStore();
    store.append('brand-new', userMessage('hi'));
    expect(store.getSession('brand-new')).toBeDefined();
    store.close();
  });

  it('applies schema defaults on the way in', () => {
    const store = makeStore();
    // `toolCalls` omitted — the schema's default has to fill it, or every
    // consumer would need to cope with an absent array.
    const record = store.append('s', { role: 'assistant', content: [] });
    expect(record.message).toMatchObject({ toolCalls: [] });
    store.close();
  });

  it('appends a block in one transaction with contiguous seqs', () => {
    const store = makeStore();
    const records = store.appendMany('s', [
      assistantMessage('', { toolCalls: [call('a'), call('b')] }),
      toolMessage('a', 'read_file', 'x'),
      toolMessage('b', 'read_file', 'y'),
    ]);

    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(store.messageCount('s')).toBe(3);
    store.close();
  });

  it('is a no-op for an empty block', () => {
    const store = makeStore();
    expect(store.appendMany('s', [])).toEqual([]);
    expect(store.getSession('s')).toBeUndefined();
    store.close();
  });

  it('writes nothing when any message in the block is invalid', () => {
    const store = makeStore();
    store.append('s', userMessage('first'));

    expect(() =>
      store.appendMany('s', [
        userMessage('good'),
        { role: 'tool', toolCallId: '', name: 't', content: 'x' },
      ]),
    ).toThrow(GhostError);

    // The valid sibling must not have landed either.
    expect(store.messageCount('s')).toBe(1);
    store.close();
  });

  it('reports a validation failure as invalid_input, not storage', () => {
    const store = makeStore();
    try {
      store.append('s', { role: 'nonsense' } as never);
      expect.unreachable('append should have thrown');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('invalid_input');
    }
    store.close();
  });

  it('records the turn id on every message of a turn', () => {
    const store = makeStore();
    const records = store.appendMany(
      's',
      [assistantMessage('', { toolCalls: [call('a')] }), toolMessage('a', 'read_file', 'x')],
      { turnId: 'turn-1' },
    );
    expect(records.every((r) => r.turnId === 'turn-1')).toBe(true);
    expect(store.messages('s').every((r) => r.turnId === 'turn-1')).toBe(true);
    store.close();
  });

  it('leaves turnId undefined when none was given', () => {
    const store = makeStore();
    store.append('s', userMessage('hi'));
    expect(store.messages('s')[0]?.turnId).toBeUndefined();
    store.close();
  });
});

describe('reading messages', () => {
  function seeded(): SessionStore {
    const store = makeStore();
    store.append('s', userMessage('one'));
    store.append('s', assistantMessage('two'));
    store.append('s', userMessage('three'));
    return store;
  }

  it('returns messages in sequence order', () => {
    const store = seeded();
    expect(store.messages('s').map((r) => r.seq)).toEqual([1, 2, 3]);
    store.close();
  });

  it('pages forward from a cursor', () => {
    const store = seeded();
    expect(store.messages('s', { afterSeq: 1 }).map((r) => r.seq)).toEqual([2, 3]);
    store.close();
  });

  it('respects an upper bound', () => {
    const store = seeded();
    expect(store.messages('s', { beforeSeq: 3 }).map((r) => r.seq)).toEqual([1, 2]);
    store.close();
  });

  it('limits from the start by default', () => {
    const store = seeded();
    expect(store.messages('s', { limit: 2 }).map((r) => r.seq)).toEqual([1, 2]);
    store.close();
  });

  it('takes the newest when reading from the end, still in order', () => {
    const store = seeded();
    expect(store.messages('s', { limit: 2, fromEnd: true }).map((r) => r.seq)).toEqual([2, 3]);
    store.close();
  });

  it('returns nothing for an unknown session', () => {
    const store = makeStore();
    expect(store.messages('nope')).toEqual([]);
    expect(store.messageCount('nope')).toBe(0);
    store.close();
  });

  it('narrows a record to the wire shape', () => {
    const store = makeStore();
    const record = store.append('s', userMessage('hi'), { turnId: 't1' });

    expect(toStoredMessage(record)).toEqual({
      id: 'm1',
      sessionKey: 's',
      createdAtMs: NOW,
      turnId: 't1',
      message: userMessage('hi'),
    });
    store.close();
  });

  it('omits turnId from the wire shape when absent', () => {
    const store = makeStore();
    const wire = toStoredMessage(store.append('s', userMessage('hi')));
    expect('turnId' in wire).toBe(false);
    store.close();
  });
});

describe('history', () => {
  it('is empty for an unknown session', () => {
    const store = makeStore();
    expect(store.history('nope')).toEqual([]);
    store.close();
  });

  it('skips messages already folded into the memory files', () => {
    const store = makeStore();
    store.append('s', userMessage('old'));
    store.append('s', assistantMessage('older answer'));
    store.append('s', userMessage('current'));
    store.updateSession('s', { lastConsolidatedSeq: 2 });

    expect(store.history('s')).toEqual([userMessage('current')]);
    store.close();
  });

  it('applies maxMessages to the newest messages', () => {
    const store = makeStore();
    store.append('s', userMessage('a'));
    store.append('s', userMessage('b'));
    store.append('s', userMessage('c'));

    expect(store.history('s', { maxMessages: 2 })).toEqual([userMessage('b'), userMessage('c')]);
    store.close();
  });

  it('does not double-apply the consolidation offset', () => {
    const store = makeStore();
    for (const text of ['a', 'b', 'c', 'd']) store.append('s', userMessage(text));
    store.updateSession('s', { lastConsolidatedSeq: 2 });

    // Two consolidated, two remaining — asking for two must return both of the
    // remaining pair rather than skipping a second block of two.
    expect(store.history('s', { maxMessages: 2 })).toEqual([userMessage('c'), userMessage('d')]);
    store.close();
  });

  it('drops a tool result whose assistant fell outside the window', () => {
    const store = makeStore();
    store.append('s', userMessage('read it'));
    store.append('s', assistantMessage('', { toolCalls: [call('a')] }));
    store.append('s', toolMessage('a', 'read_file', 'contents'));
    store.append('s', assistantMessage('done'));

    const history = store.history('s', { maxMessages: 2 });
    expect(hasOrphanedToolResult(history)).toBe(false);
    store.close();
  });

  it('truncates oversized tool results', () => {
    const store = makeStore();
    store.append('s', userMessage('go'));
    store.append('s', assistantMessage('', { toolCalls: [call('a')] }));
    store.append('s', toolMessage('a', 'read_file', 'y'.repeat(500)));

    const tool = store.history('s', { maxToolResultChars: 50 })[2];
    if (tool?.role !== 'tool') throw new Error('expected a tool message');
    expect(tool.truncated).toBe(true);
    store.close();
  });
});

describe('durability', () => {
  it('survives a reopen with tool-call pairing intact', () => {
    const file = tempFile();

    const first = new SessionStore({ file, clock: fixedClock, newId: counterIds() });
    first.appendMany(
      'web:1',
      [
        userMessage('read a.txt and b.txt'),
        assistantMessage('', { toolCalls: [call('a'), call('b')] }),
        toolMessage('a', 'read_file', 'contents of a'),
        toolMessage('b', 'read_file', 'contents of b'),
        assistantMessage('Both read.'),
      ],
      { turnId: 'turn-1' },
    );
    first.updateSession('web:1', { title: 'Reading files' });
    first.close();

    const second = new SessionStore({ file, clock: fixedClock, newId: counterIds() });
    const history = second.history('web:1');

    expect(second.getSession('web:1')?.title).toBe('Reading files');
    expect(history).toHaveLength(5);
    expect(hasOrphanedToolResult(history)).toBe(false);
    expect(second.messages('web:1').map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
    second.close();
  });

  it('continues the sequence after a reopen rather than restarting it', () => {
    const file = tempFile();

    const first = new SessionStore({ file, clock: fixedClock, newId: counterIds() });
    first.append('s', userMessage('one'));
    first.close();

    const second = new SessionStore({ file, clock: fixedClock, newId: counterIds('second-') });
    expect(second.append('s', userMessage('two')).seq).toBe(2);
    second.close();
  });

  it('creates the database directory if it is missing', () => {
    const file = join(tempFile(), 'nested', 'ghost.db');
    const store = new SessionStore({ file, clock: fixedClock });
    store.append('s', userMessage('hi'));
    expect(store.messageCount('s')).toBe(1);
    store.close();
  });
});

describe('clearing', () => {
  it('removes messages but keeps the session and its sequence', () => {
    const store = makeStore();
    store.append('s', userMessage('one'));
    store.append('s', userMessage('two'));
    store.updateSession('s', { lastConsolidatedSeq: 2, lastLearnedSeq: 2 });

    store.clearMessages('s');

    expect(store.messageCount('s')).toBe(0);
    expect(store.getSession('s')?.lastConsolidatedSeq).toBe(0);
    expect(store.getSession('s')?.lastLearnedSeq).toBe(0);
    // Sequences never rewind: a reconnecting client's stale cursor must not
    // start addressing different messages.
    expect(store.append('s', userMessage('three')).seq).toBe(3);
    store.close();
  });
});

describe('lifecycle', () => {
  it('closes idempotently', () => {
    const store = makeStore();
    store.close();
    expect(() => {
      store.close();
    }).not.toThrow();
  });

  it('refuses to work after close', () => {
    const store = makeStore();
    store.close();
    expect(() => store.append('s', userMessage('hi'))).toThrow(GhostError);
    expect(() => store.getSession('s')).toThrow(GhostError);
  });

  it('leaves a borrowed connection open for its owner', () => {
    const database = new DatabaseSync(':memory:');
    const store = new SessionStore({ database, clock: fixedClock });
    store.append('s', userMessage('hi'));
    store.close();

    // Still usable: whoever opened the connection owns its lifetime.
    expect(database.prepare('SELECT COUNT(*) AS n FROM messages').get()).toMatchObject({ n: 1 });
    database.close();
  });
});

describe('corrupt data', () => {
  it('rejects a stored payload that no longer matches the schema', () => {
    const database = new DatabaseSync(':memory:');
    const store = new SessionStore({ database, clock: fixedClock, newId: counterIds() });
    store.append('s', userMessage('hi'));

    database.prepare('UPDATE messages SET payload_json = ? WHERE seq = 1').run('{"role":"alien"}');

    try {
      store.messages('s');
      expect.unreachable('reading a corrupt payload should throw');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('storage');
    }
    store.close();
    database.close();
  });

  it('falls back to empty metadata rather than losing the session', () => {
    const database = new DatabaseSync(':memory:');
    const store = new SessionStore({ database, clock: fixedClock });
    store.ensureSession('s');

    for (const bad of ['not json at all', '[1,2,3]', 'null']) {
      database.prepare('UPDATE sessions SET metadata_json = ? WHERE key = ?').run(bad, 's');
      expect(store.getSession('s')?.metadata).toEqual({});
    }

    store.close();
    database.close();
  });
});
