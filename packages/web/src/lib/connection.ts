/**
 * The one socket, and the functions that speak on it.
 *
 * Plain module functions over a singleton rather than a hook, for the same
 * reason `toast()` is: the callers are not all components. The composer sends a
 * message, a tool card answers an approval, a keyboard shortcut stops a turn,
 * and the shell owns the lifecycle — a `useConnection()` returning a `send`
 * would have to be threaded through every one of them, and would hand each a
 * different closure to hold stale state in.
 *
 * The lifecycle is `useConnection` in `chat/use-connection.ts`; this file is
 * what it drives. The split matters because the socket must outlive the chat
 * route: navigating to Settings and back should not drop a turn in flight, and
 * the shell — the router's root — is the only component that never remounts.
 *
 * ## Who resumes
 *
 * `open()` dials without a `session.resume`. A first connection has nothing to
 * resume: `lastSeq` is 0, and asking to replay from 0 would ask for the whole
 * ring, which is the same conversation the REST history is already loading.
 * Every *re*-connection sends one, because that is the case the ring exists
 * for — a tab that reloaded mid-turn rebuilds the in-flight answer from it.
 */

import type { ApprovalScope, Attachment, ServerMessage } from '@ghostai/protocol';

import { useTurnStore } from '@/state/turn.js';
import { toast } from '@/components/ui/toast.js';
import { readCursor, writeCursor } from './cursor.js';
import { ReconnectingSocket, socketUrl, type ConnectionStatus } from './socket.js';

type Listener = (message: ServerMessage) => void;

const listeners = new Set<Listener>();

let socket: ReconnectingSocket | undefined;
/** The session the *URL* asked for, which is not always the one attached yet. */
let requested: string | undefined;

/**
 * Subscribe to every parsed frame.
 *
 * The store already applies them; this is for the effects that are not state —
 * invalidating the session list when a turn ends, raising a toast for a
 * notification. Returns the unsubscribe.
 */
export function onServerMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens the socket on `sessionKey`, or on a server-minted one when absent. */
export function openConnection(sessionKey: string | undefined): void {
  requested = sessionKey;
  if (sessionKey !== undefined) attachWithCursor(sessionKey);

  socket ??= new ReconnectingSocket({
    url: () => socketUrl(requested ?? useTurnStore.getState().sessionKey, globalThis.location),
    onStatus: handleStatus,
    onMessage: handleMessage,
    onOpen: (send) => {
      const { sessionKey: attached, lastSeq } = useTurnStore.getState();
      // A cursor of zero is a conversation this tab has never rendered a frame
      // of, so there is nothing after it to replay and the REST history is the
      // whole story. Anything above zero is a reconnect or a reload, which is
      // the case the ring exists for.
      if (attached === undefined || lastSeq === 0) return;
      send({ type: 'session.resume', sessionKey: attached, lastSeq });
    },
    onInvalidFrame: (reason) => {
      // A server this client cannot read is a version skew, and the honest
      // report names it rather than letting the UI quietly miss events.
      toast.error('Unreadable message from the server', reason);
    },
  });

  socket.open();
}

export function closeConnection(): void {
  socket?.close();
  socket = undefined;
  requested = undefined;
}

/**
 * Points the connection at another conversation.
 *
 * `session.resume` rather than `session.switch`, and not by accident: the hub's
 * resume *is* a switch that also replays, so one frame both moves the
 * connection and picks up a turn that is already running on the session being
 * opened. `session.switch` would arrive at a live conversation and show
 * nothing until the next token.
 *
 * A re-dial when the socket is down, because the frame needs a connection to
 * travel on and buffering it would leave the UI showing a session the server is
 * not sending events for.
 */
export function switchSession(sessionKey: string): void {
  // The condition is "is the connection already on this conversation", and it
  // has to read the *store*, not just what was last requested. A tab that
  // opened without a `?session=` is attached to a key the server minted, and
  // the URL only catches up a moment later — asking to switch to the session
  // already being watched would resume it, and the ring would re-deliver
  // frames this client had already applied.
  if (requested === sessionKey || useTurnStore.getState().sessionKey === sessionKey) {
    requested = sessionKey;
    return;
  }
  requested = sessionKey;
  const lastSeq = attachWithCursor(sessionKey);

  if (socket === undefined) return;
  if (socket.status === 'open') {
    socket.send({ type: 'session.resume', sessionKey, lastSeq });
    return;
  }
  socket.reconnectNow();
}

/**
 * Attaches to a session and restores the cursor this tab last had on it.
 *
 * The cursor is what makes a reload different from a fresh visit: without it,
 * `lastSeq` is 0 and the in-flight turn the user was watching is unrecoverable,
 * because storage does not hold a half-written answer.
 */
function attachWithCursor(sessionKey: string): number {
  const store = useTurnStore.getState();
  store.attach(sessionKey);

  const cursor = readCursor(sessionKey);
  store.applySeq(cursor);
  return useTurnStore.getState().lastSeq;
}

/** Starts a fresh conversation, letting the server name it. */
export function newSession(): void {
  socket?.send({ type: 'session.new' });
}

export function sendUserMessage(text: string, attachments: readonly Attachment[] = []): void {
  const store = useTurnStore.getState();
  const sessionKey = store.sessionKey;
  if (sessionKey === undefined || socket === undefined) return;

  // The idempotency key. A retry after a dropped socket — which the buffer in
  // `socket.ts` makes routine — is acked with the id the first attempt got,
  // and no second turn is queued.
  const clientMessageId = crypto.randomUUID();

  store.appendPending({ clientMessageId, text, attachments });
  socket.send({
    type: 'user.message',
    sessionKey,
    content: text,
    attachments: [...attachments],
    clientMessageId,
  });
}

export function stopTurn(): void {
  const sessionKey = useTurnStore.getState().sessionKey;
  if (sessionKey === undefined) return;
  socket?.send({ type: 'turn.stop', sessionKey });
}

export function steerTurn(content: string): void {
  const sessionKey = useTurnStore.getState().sessionKey;
  if (sessionKey === undefined) return;
  socket?.send({ type: 'turn.steer', sessionKey, content });
}

export function approveTool(callId: string, approved: boolean, scope: ApprovalScope): void {
  // Recorded locally first, so the buttons go on the click rather than on the
  // round trip. The gate is the server's; the acknowledgement is ours.
  useTurnStore.getState().answerApproval(callId, approved ? 'approved' : 'denied');
  socket?.send({ type: 'tool.approve', callId, approved, scope });
}

/** Test seam: the socket is module state, and a suite needs it absent per case. */
export function resetConnection(): void {
  socket?.close();
  socket = undefined;
  requested = undefined;
  listeners.clear();
}

function handleStatus(status: ConnectionStatus): void {
  const previous = useTurnStore.getState().connection;
  useTurnStore.getState().setConnection(status);

  // Only on the transition, and only downwards: a socket that reconnects six
  // times over a lunch break should not leave six toasts stacked up.
  if (status === 'reconnecting' && previous === 'open') {
    toast({
      title: 'Connection lost',
      description: 'Reconnecting. The turn keeps running on the server.',
      role: 'warning',
      durationMs: 4000,
    });
  }
}

function handleMessage(message: ServerMessage): void {
  const store = useTurnStore.getState();
  store.apply(message);

  // Written here rather than on a schedule: the whole value of the cursor is
  // that it is correct at an arbitrary moment, because the moment it has to
  // survive — a reload — arrives without warning. See `cursor.ts`.
  const { sessionKey, lastSeq } = useTurnStore.getState();
  if (sessionKey !== undefined && lastSeq > 0) writeCursor(sessionKey, lastSeq);

  // A connection-scoped error has no turn to attach to, so it has nowhere to
  // render — a toast is the only place it can be seen at all.
  if (message.type === 'error' && message.turnId === undefined) {
    toast.error('Server error', message.message);
  }

  for (const listener of listeners) listener(message);
}
