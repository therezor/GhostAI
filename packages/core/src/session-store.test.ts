import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { GhostError, isGhostError } from './errors.js';
import { hasOrphanedToolResult } from './history.js';
import { assistantMessage, textOf, toolMessage, userMessage } from './messages.js';
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
 * production uses `newUuid`, so only a fixture can collide this way.
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
      agentId: undefined,
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

  it('lists every origin, because a hidden transcript is an undiagnosable one', () => {
    // This used to exclude `subagent` and `automation` on the grounds that
    // neither is a conversation a person had. The result was a scheduled run
    // whose turn could not be opened from anywhere: absent from the sidebar, and
    // the job's run history showed its output without linking to the session.
    // Provenance stays a column — `origin` still says who started each one.
    const store = makeStore();
    store.ensureSession('a', { origin: 'web' });
    store.ensureSession('sub', { origin: 'subagent' });
    store.ensureSession('auto', { origin: 'automation' });

    expect(
      store
        .listSessions()
        .map((s) => s.key)
        .sort(),
    ).toEqual(['a', 'auto', 'sub']);
    expect(store.listSessions().find((s) => s.key === 'auto')?.origin).toBe('automation');
    store.close();
  });

  it('still lists a machine-started origin when asked for it by name', () => {
    // What the run history's "open in chat" link relies on.
    const store = makeStore();
    store.ensureSession('a', { origin: 'web' });
    store.ensureSession('auto', { origin: 'automation' });

    expect(store.listSessions({ origin: 'automation' }).map((s) => s.key)).toEqual(['auto']);
    expect(store.getSession('auto')?.origin).toBe('automation');
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

  it('matches a title substring, case-insensitively', () => {
    const store = makeStore();
    store.ensureSession('a', { title: 'Fix the login throttle' });
    store.ensureSession('b', { title: 'Nightly digest' });
    store.ensureSession('c', { title: 'LOGIN rate limits' });

    expect(
      store
        .listSessions({ query: 'login' })
        .map((session) => session.key)
        .sort(),
    ).toEqual(['a', 'c']);
    store.close();
  });

  it('treats a blank query as no query, rather than as LIKE %%', () => {
    const store = makeStore();
    store.ensureSession('a', { title: 'One' });
    store.ensureSession('b', { title: '' });

    for (const query of ['', '   ']) {
      expect(
        store
          .listSessions({ query })
          .map((session) => session.key)
          .sort(),
      ).toEqual(['a', 'b']);
    }
    store.close();
  });

  it('searches for a wildcard rather than with one', () => {
    // Unescaped, `100%` is `LIKE '%100%%'` — which matches every title starting
    // `100`, and `_` would match any single character.
    const store = makeStore();
    store.ensureSession('a', { title: 'Down to 100% coverage' });
    store.ensureSession('b', { title: '100 tests and counting' });
    store.ensureSession('c', { title: 'a_b' });
    store.ensureSession('d', { title: 'axb' });

    expect(store.listSessions({ query: '100%' }).map((session) => session.key)).toEqual(['a']);
    expect(store.listSessions({ query: 'a_b' }).map((session) => session.key)).toEqual(['c']);
    store.close();
  });

  it('orders by each column it offers, in both directions', () => {
    let now = NOW;
    const store = new SessionStore({
      clock: { ...fixedClock, now: () => now },
      file: ':memory:',
    });

    store.ensureSession('a', { title: 'Beta' });
    now = NOW + 1;
    store.ensureSession('b', { title: 'alpha' });
    now = NOW + 2;
    store.ensureSession('c', { title: 'Gamma' });

    const keys = (options: Parameters<typeof store.listSessions>[0]): string[] =>
      store.listSessions(options).map((session) => session.key);

    expect(keys({})).toEqual(['c', 'b', 'a']);
    expect(keys({ orderBy: 'created', descending: false })).toEqual(['a', 'b', 'c']);
    // NOCASE, so `alpha` sorts with the capitals rather than after them.
    expect(keys({ orderBy: 'title', descending: false })).toEqual(['b', 'a', 'c']);
    expect(keys({ orderBy: 'title', descending: true })).toEqual(['c', 'a', 'b']);
    store.close();
  });

  it('refuses a cursor under an ordering it does not address', () => {
    const store = makeStore();
    store.ensureSession('a');

    expect(() =>
      store.listSessions({ orderBy: 'title', after: { updatedAtMs: NOW, key: 'a' } }),
    ).toThrow(/only valid in the default ordering/);
    expect(() =>
      store.listSessions({ descending: false, after: { updatedAtMs: NOW, key: 'a' } }),
    ).toThrow(/only valid in the default ordering/);
    store.close();
  });

  it('counts what the same filter lists, so a pager cannot disagree with its rows', () => {
    const store = makeStore();
    store.ensureSession('a', { title: 'login throttle', workspaceId: 'default' });
    store.ensureSession('b', { title: 'login rate limit', workspaceId: 'default' });
    store.ensureSession('c', { title: 'nightly digest', workspaceId: 'default' });
    store.ensureSession('d', {
      title: 'login elsewhere',
      workspaceId: 'other',
      origin: 'telegram',
    });

    for (const options of [
      {},
      { query: 'login' },
      { workspaceId: 'default' },
      { workspaceId: 'default', query: 'login' },
      { origin: 'telegram' },
      { query: 'nothing matches this' },
    ]) {
      // The page is capped well above the row count, so the two are comparable.
      expect(store.countSessions(options)).toBe(
        store.listSessions({ ...options, limit: 100 }).length,
      );
    }

    expect(store.countSessions({ query: 'login' })).toBe(3);
    store.close();
  });

  it('counts the whole match rather than the page in front of it', () => {
    const store = makeStore();
    for (const key of ['a', 'b', 'c', 'd', 'e']) store.ensureSession(key);

    expect(store.listSessions({ limit: 2 })).toHaveLength(2);
    expect(store.countSessions({ limit: 2 })).toBe(5);
    store.close();
  });

  it('patches only the fields it is given', () => {
    const store = makeStore();
    store.ensureSession('a', { title: 'Title', agentId: 'p1' });

    const updated = store.updateSession('a', { lastConsolidatedSeq: 4 });
    expect(updated.title).toBe('Title');
    expect(updated.agentId).toBe('p1');
    expect(updated.lastConsolidatedSeq).toBe(4);
    store.close();
  });

  it('distinguishes clearing an agent from leaving it alone', () => {
    const store = makeStore();
    store.ensureSession('a', { agentId: 'p1' });

    expect(store.updateSession('a', { title: 'x' }).agentId).toBe('p1');
    expect(store.updateSession('a', { agentId: null }).agentId).toBeUndefined();
    expect(store.getSession('a')?.agentId).toBeUndefined();
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
      seq: 1,
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

describe('truncating', () => {
  it('drops everything after the cut and reports how much', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three', 'four']) store.append('s', userMessage(text));

    expect(store.truncateAfter('s', 2)).toEqual({ seq: 2, deleted: 2 });
    expect(store.messages('s').map((record) => record.seq)).toEqual([1, 2]);
    store.close();
  });

  it('leaves next_seq alone, so sequences never rewind', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three']) store.append('s', userMessage(text));

    store.truncateAfter('s', 1);

    // The load-bearing property: the gap is deliberate. A reconnecting client
    // holding `afterSeq: 2` must not have it start addressing a new message.
    expect(store.append('s', userMessage('next')).seq).toBe(4);
    store.close();
  });

  it('clamps both markers to the cut', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three', 'four']) store.append('s', userMessage(text));
    store.updateSession('s', { lastConsolidatedSeq: 3, lastLearnedSeq: 4 });

    store.truncateAfter('s', 2);

    const session = store.getSession('s');
    expect(session?.lastConsolidatedSeq).toBe(2);
    expect(session?.lastLearnedSeq).toBe(2);
    store.close();
  });

  it('leaves a marker below the cut where it is', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three']) store.append('s', userMessage(text));
    store.updateSession('s', { lastConsolidatedSeq: 1 });

    store.truncateAfter('s', 2);

    expect(store.getSession('s')?.lastConsolidatedSeq).toBe(1);
    store.close();
  });

  it('snaps back past an assistant whose tool calls would be stranded', () => {
    const store = makeStore();
    store.append('s', userMessage('read it'));
    store.append('s', assistantMessage('', { toolCalls: [call('a')] }));
    store.append('s', toolMessage('a', 'read_file', 'contents'));
    store.append('s', assistantMessage('done'));

    // Asking to keep seq 1..2 would leave the assistant declaring `a` with no
    // answer — a provider 400 on the next turn.
    const result = store.truncateAfter('s', 2);

    expect(result.seq).toBe(1);
    expect(store.messages('s').map((record) => record.seq)).toEqual([1]);
    store.close();
  });

  it('does not snap a cut that is already legal', () => {
    const store = makeStore();
    store.append('s', userMessage('read it'));
    store.append('s', assistantMessage('', { toolCalls: [call('a')] }));
    store.append('s', toolMessage('a', 'read_file', 'contents'));
    store.append('s', assistantMessage('done'));

    expect(store.truncateAfter('s', 3).seq).toBe(3);
    store.close();
  });

  it('is a no-op past the end, and does not bump the session', () => {
    const store = makeStore();
    store.append('s', userMessage('one'));
    const before = store.getSession('s')?.updatedAtMs;

    expect(store.truncateAfter('s', 99)).toEqual({ seq: 99, deleted: 0 });
    expect(store.messageCount('s')).toBe(1);
    expect(store.getSession('s')?.updatedAtMs).toBe(before);
    store.close();
  });

  it('clears a session when cut at zero', () => {
    const store = makeStore();
    store.append('s', userMessage('one'));
    store.append('s', userMessage('two'));

    expect(store.truncateAfter('s', 0).deleted).toBe(2);
    expect(store.messageCount('s')).toBe(0);
    store.close();
  });

  it('rejects an unknown session', () => {
    const store = makeStore();
    expect(() => store.truncateAfter('nope', 1)).toThrow(GhostError);
    store.close();
  });

  it('leaves history readable — no orphaned tool result survives', () => {
    const store = makeStore();
    store.append('s', userMessage('read it'));
    store.append('s', assistantMessage('', { toolCalls: [call('a')] }));
    store.append('s', toolMessage('a', 'read_file', 'contents'));

    store.truncateAfter('s', 2);

    expect(hasOrphanedToolResult(store.history('s'))).toBe(false);
    store.close();
  });
});

describe('forking', () => {
  it('copies the prefix into a new session and leaves the source alone', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three']) store.append('s', userMessage(text));

    const fork = store.forkSession('s', 2);

    expect(fork.copied).toBe(2);
    expect(fork.seq).toBe(2);
    expect(store.messages(fork.session.key).map((r) => textOf(r.message))).toEqual(['one', 'two']);
    expect(store.messageCount('s')).toBe(3);
    store.close();
  });

  it('reseats sequences densely from one', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three']) store.append('s', userMessage(text));
    store.truncateAfter('s', 1);
    store.append('s', userMessage('sparse'));

    const fork = store.forkSession('s', 99);

    // The source's seqs are 1 and 4; a fork is a new sequence space.
    expect(store.messages(fork.session.key).map((r) => r.seq)).toEqual([1, 2]);
    expect(store.append(fork.session.key, userMessage('next')).seq).toBe(3);
    store.close();
  });

  it('mints new row ids but preserves turn ids and creation times', () => {
    const store = makeStore();
    const original = store.append('s', userMessage('one'), { turnId: 't1' });

    const fork = store.forkSession('s', 1);
    const copied = store.messages(fork.session.key)[0];

    expect(copied?.id).not.toBe(original.id);
    expect(copied?.turnId).toBe('t1');
    expect(copied?.createdAtMs).toBe(original.createdAtMs);
    store.close();
  });

  it('inherits workspace, origin and agent', () => {
    const store = makeStore();
    store.ensureSession('s', { origin: 'cli', workspaceId: 'w2', agentId: 'p1' });
    store.append('s', userMessage('one'));

    const fork = store.forkSession('s', 1);

    expect(fork.session.origin).toBe('cli');
    expect(fork.session.workspaceId).toBe('w2');
    expect(fork.session.agentId).toBe('p1');
    // A key of its own, and nothing encoded in it: the origin it inherited is
    // the column above, which is what anything reads.
    expect(fork.session.key).not.toBe('s');
    store.close();
  });

  it('records where it came from', () => {
    const store = makeStore();
    store.append('s', userMessage('one'));

    const fork = store.forkSession('s', 1);

    expect(fork.session.metadata.forkedFrom).toEqual({ key: 's', seq: 1, atMs: NOW });
    store.close();
  });

  it('carries the source title, and derives one when the source has none', () => {
    const store = makeStore();
    store.append('s', userMessage('why does the login throw'));
    store.ensureSession('titled', { title: 'Named already' });
    store.append('titled', userMessage('anything'));

    expect(store.forkSession('s', 1).session.title).toBe('why does the login throw');
    expect(store.forkSession('titled', 1).session.title).toBe('Named already');
    store.close();
  });

  it('remaps the consolidation markers by count', () => {
    const store = makeStore();
    for (const text of ['one', 'two', 'three', 'four']) store.append('s', userMessage(text));
    store.updateSession('s', { lastConsolidatedSeq: 2, lastLearnedSeq: 3 });

    const fork = store.forkSession('s', 4);

    expect(fork.session.lastConsolidatedSeq).toBe(2);
    expect(fork.session.lastLearnedSeq).toBe(3);
    store.close();
  });

  it('snaps to a legal boundary', () => {
    const store = makeStore();
    store.append('s', userMessage('read it'));
    store.append('s', assistantMessage('', { toolCalls: [call('a')] }));
    store.append('s', toolMessage('a', 'read_file', 'contents'));

    const fork = store.forkSession('s', 2);

    expect(fork.seq).toBe(1);
    expect(fork.copied).toBe(1);
    store.close();
  });

  it('forks an empty session at seq zero', () => {
    const store = makeStore();
    store.append('s', userMessage('one'));

    const fork = store.forkSession('s', 0);

    expect(fork.copied).toBe(0);
    expect(store.append(fork.session.key, userMessage('first')).seq).toBe(1);
    store.close();
  });

  it('honours an explicit key and refuses to overwrite one', () => {
    const store = makeStore();
    store.append('s', userMessage('one'));

    expect(store.forkSession('s', 1, { key: 'chosen' }).session.key).toBe('chosen');
    expect(() => store.forkSession('s', 1, { key: 'chosen' })).toThrow(GhostError);
    store.close();
  });

  it('rejects an unknown source', () => {
    const store = makeStore();
    expect(() => store.forkSession('nope', 1)).toThrow(GhostError);
    store.close();
  });
});

describe('turn stats', () => {
  const stats = (turnId: string, overrides: Record<string, unknown> = {}) => ({
    turnId,
    sessionKey: 's',
    agentId: 'default',
    provider: 'anthropic',
    model: 'claude-opus-5',
    startedAtMs: NOW,
    endedAtMs: NOW + 1000,
    iterations: 2,
    stopReason: 'complete' as const,
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    ...overrides,
  });

  it('records and reads back a turn', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.recordTurnStats(stats('t1'));

    expect(store.turnStats('s')).toEqual([stats('t1')]);
    store.close();
  });

  it('keeps the agent that ran the turn, not the one the session now names', () => {
    const store = makeStore();
    store.ensureSession('s', { agentId: 'reviewer' });
    store.recordTurnStats(stats('t1', { agentId: 'reviewer' }));

    // The session moves; the turn that already ran does not move with it.
    store.updateSession('s', { agentId: 'writer' });

    expect(store.turnStats('s')[0]?.agentId).toBe('reviewer');
    store.close();
  });

  it('upserts rather than throwing when a turn ends twice', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.recordTurnStats(stats('t1'));
    store.recordTurnStats(stats('t1', { iterations: 5 }));

    expect(store.turnStats('s')).toHaveLength(1);
    expect(store.turnStats('s')[0]?.iterations).toBe(5);
    store.close();
  });

  it('returns the most recent turn first, and honours a limit', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.recordTurnStats(stats('t1', { endedAtMs: NOW + 1 }));
    store.recordTurnStats(stats('t2', { endedAtMs: NOW + 2 }));
    store.recordTurnStats(stats('t3', { endedAtMs: NOW + 3 }));

    expect(store.turnStats('s').map((row) => row.turnId)).toEqual(['t3', 't2', 't1']);
    expect(store.turnStats('s', { limit: 2 }).map((row) => row.turnId)).toEqual(['t3', 't2']);
    store.close();
  });

  it('keeps the optional usage fields optional', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.recordTurnStats(
      stats('t1', { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } }),
    );
    store.recordTurnStats(
      stats('t2', {
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, cachedTokens: 9 },
      }),
    );

    const rows = store.turnStats('s');
    expect(rows.find((row) => row.turnId === 't1')?.usage.cachedTokens).toBeUndefined();
    expect(rows.find((row) => row.turnId === 't2')?.usage.cachedTokens).toBe(9);
    store.close();
  });

  it('sums usage per session in one query', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.ensureSession('other');
    store.recordTurnStats(stats('t1'));
    store.recordTurnStats(
      stats('t2', { usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } }),
    );
    store.recordTurnStats(stats('t3', { sessionKey: 'other' }));

    const totals = store.sessionUsage(['s', 'other', 'missing']);

    expect(totals.get('s')).toEqual({ promptTokens: 105, completionTokens: 25, totalTokens: 130 });
    expect(totals.get('other')?.totalTokens).toBe(120);
    // A session with no recorded turns is absent rather than zeroed — the
    // honest answer for a conversation whose turns predate this table.
    expect(totals.has('missing')).toBe(false);
    store.close();
  });

  it('reports no cached total when no turn reported one', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.recordTurnStats(stats('t1'));

    expect(store.sessionUsage(['s']).get('s')?.cachedTokens).toBeUndefined();
    store.close();
  });

  it('returns an empty map for an empty page', () => {
    const store = makeStore();
    expect(store.sessionUsage([]).size).toBe(0);
    store.close();
  });

  it('goes away with the session', () => {
    const store = makeStore();
    store.ensureSession('s');
    store.recordTurnStats(stats('t1'));

    store.deleteSession('s');

    expect(store.turnStats('s')).toEqual([]);
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

describe('reassigning an agent', () => {
  it('moves every conversation bound to the old id', () => {
    const store = makeStore();
    store.ensureSession('a', { agentId: 'reviewer' });
    store.ensureSession('b', { agentId: 'reviewer' });

    expect(store.reassignAgent('reviewer', 'code-review')).toBe(2);
    expect(store.getSession('a')?.agentId).toBe('code-review');
    expect(store.getSession('b')?.agentId).toBe('code-review');
  });

  it('leaves conversations bound to other agents, and unbound ones, alone', () => {
    const store = makeStore();
    store.ensureSession('mine', { agentId: 'reviewer' });
    store.ensureSession('theirs', { agentId: 'writer' });
    store.ensureSession('nobody');

    expect(store.reassignAgent('reviewer', 'code-review')).toBe(1);
    expect(store.getSession('theirs')?.agentId).toBe('writer');
    expect(store.getSession('nobody')?.agentId).toBeUndefined();
  });

  it('does not rewrite which agent ran a past turn', () => {
    // `turn_stats.agent_id` is a record of what happened, not a pointer to what
    // exists now. A transcript that relabelled its history after a rename would
    // be describing turns under a name they were never run with.
    const store = makeStore();
    store.ensureSession('s', { agentId: 'reviewer' });
    store.recordTurnStats({
      turnId: 't1',
      sessionKey: 's',
      agentId: 'reviewer',
      provider: 'anthropic',
      model: 'claude-opus-5',
      startedAtMs: NOW,
      endedAtMs: NOW + 1000,
      iterations: 1,
      stopReason: 'complete',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    store.reassignAgent('reviewer', 'code-review');

    expect(store.getSession('s')?.agentId).toBe('code-review');
    expect(store.turnStats('s')[0]?.agentId).toBe('reviewer');
  });

  it('reports nothing moved when no conversation names the old id', () => {
    const store = makeStore();
    store.ensureSession('s');

    expect(store.reassignAgent('reviewer', 'code-review')).toBe(0);
  });

  it('applies every rename in one save', () => {
    const store = makeStore();
    store.ensureSession('a', { agentId: 'reviewer' });
    store.ensureSession('b', { agentId: 'writer' });

    const moved = store.reassignAgents([
      { from: 'reviewer', to: 'code-review' },
      { from: 'writer', to: 'author' },
    ]);

    expect(moved).toBe(2);
    expect(store.getSession('a')?.agentId).toBe('code-review');
    expect(store.getSession('b')?.agentId).toBe('author');
  });

  it('skips a rename that moves an id onto itself', () => {
    const store = makeStore();
    store.ensureSession('a', { agentId: 'reviewer' });

    expect(store.reassignAgents([{ from: 'reviewer', to: 'reviewer' }])).toBe(0);
    expect(store.getSession('a')?.agentId).toBe('reviewer');
  });

  it('does nothing at all for an empty list', () => {
    const store = makeStore();
    store.ensureSession('a', { agentId: 'reviewer' });

    expect(store.reassignAgents([])).toBe(0);
    expect(store.getSession('a')?.agentId).toBe('reviewer');
  });
});
