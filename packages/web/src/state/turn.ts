/**
 * Live turn state.
 *
 * Zustand rather than TanStack Query, because the two model opposite things.
 * Query owns *fetched* state: a request, a cache entry, a staleness rule. A
 * streaming turn is none of those — it arrives as hundreds of deltas that are
 * accumulated, not replaced, and there is no key to invalidate and no request
 * to retry. Modelling it as a query means either `setQueryData` on every token
 * or a refetch that would ask the server to repeat a stream it is already
 * sending.
 *
 * The split holds for the rest of the app too: the session list, settings and
 * files are Query; the turn in flight is here.
 *
 * Step 17 fills this in — the socket, the delta coalescing on
 * `requestAnimationFrame`, the tool cards, the replay resume. What exists now is
 * the shape those pieces write into, and the two things the shell already reads:
 * whether a turn is running, and whether the socket is connected.
 */

import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface TurnState {
  /** The session the socket is attached to, or `undefined` before the first. */
  readonly sessionKey: string | undefined;
  readonly connection: ConnectionStatus;
  /** True between `turn.start` and `turn.end` — what drives send ⇄ stop. */
  readonly busy: boolean;
  /** The last server `seq` applied, which a reconnect resumes from. */
  readonly lastSeq: number;

  readonly setConnection: (connection: ConnectionStatus) => void;
  readonly setBusy: (busy: boolean) => void;
  readonly attach: (sessionKey: string) => void;
  readonly applySeq: (seq: number) => void;
  readonly reset: () => void;
}

const INITIAL = {
  sessionKey: undefined,
  connection: 'closed' as ConnectionStatus,
  busy: false,
  lastSeq: 0,
};

export const useTurnStore = create<TurnState>((set) => ({
  ...INITIAL,

  setConnection: (connection) => {
    set({ connection });
  },
  setBusy: (busy) => {
    set({ busy });
  },
  attach: (sessionKey) => {
    // A different session is a different replay buffer: carrying `lastSeq`
    // across would resume from a sequence number that means nothing there.
    set((state) =>
      state.sessionKey === sessionKey ? {} : { sessionKey, lastSeq: 0, busy: false },
    );
  },
  applySeq: (seq) => {
    // Monotonic: a replayed frame that arrives after a live one must not move
    // the cursor backwards, or the next resume asks for events twice.
    set((state) => (seq > state.lastSeq ? { lastSeq: seq } : {}));
  },
  reset: () => {
    set(INITIAL);
  },
}));
