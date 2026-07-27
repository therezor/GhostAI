/**
 * Where this tab had got to, across a reload.
 *
 * The replay buffer is the only thing that can rebuild a turn that has not
 * finished — storage holds no half-written assistant message — and the protocol
 * asks for one number to do it: the last `seq` the client rendered. That number
 * lives in memory, and a reload is precisely the event that destroys memory. So
 * it is written where a reload does not reach: `sessionStorage`, which is
 * per-tab and survives F5, and is therefore exactly the granularity of the thing
 * being recovered from. `localStorage` would be wrong — two tabs on two
 * conversations would overwrite each other's cursor.
 *
 * It is written on every frame rather than on a flush schedule. A `setItem` of
 * fifty bytes is a few microseconds against an in-memory map, and the
 * alternative — a timer, plus `pagehide`, plus the knowledge that a crash
 * between flushes loses the turn — is more machinery protecting less.
 *
 * One session at a time, deliberately. A tab watches one conversation; a map
 * keyed by session would grow for the life of the tab to answer a question
 * nobody asks.
 */

const KEY = 'ghostai.cursor';

interface Cursor {
  readonly sessionKey: string;
  readonly lastSeq: number;
}

/**
 * The stored cursor for this session, or 0.
 *
 * Zero for a different session, for a corrupt entry, and for storage that
 * throws — which it does in a cross-origin iframe and under Safari's private
 * mode. A cursor of 0 means "resume nothing", which is the safe answer to every
 * one of those.
 */
export function readCursor(sessionKey: string, storage: Storage | undefined = safeStorage()): number {
  try {
    const raw = storage?.getItem(KEY);
    if (raw === null || raw === undefined) return 0;

    const parsed: unknown = JSON.parse(raw);
    if (!isCursor(parsed) || parsed.sessionKey !== sessionKey) return 0;
    return parsed.lastSeq;
  } catch {
    return 0;
  }
}

export function writeCursor(
  sessionKey: string,
  lastSeq: number,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ sessionKey, lastSeq } satisfies Cursor));
  } catch {
    // A tab that cannot rebuild its in-flight turn after a reload beats a tab
    // that throws while rendering one.
  }
}

export function clearCursor(storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    // See above.
  }
}

function isCursor(value: unknown): value is Cursor {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Cursor>;
  return (
    typeof candidate.sessionKey === 'string' &&
    typeof candidate.lastSeq === 'number' &&
    Number.isInteger(candidate.lastSeq) &&
    candidate.lastSeq >= 0
  );
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
