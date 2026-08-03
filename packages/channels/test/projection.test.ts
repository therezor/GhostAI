import { describe, expect, it } from 'vitest';

import type { ServerMessage } from '@ghostai/protocol';

import { TurnProjection, type OutboundDraft } from '#src/projection.js';

const TURN = 't1';

/** Distributes `Omit` over the union, which a bare `Omit` would collapse. */
type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;

/** The events of a turn, without restating `seq` at every call site. */
let seq = 0;
function event(message: Unsequenced<ServerMessage>): ServerMessage {
  seq += 1;
  return { ...message, seq } as ServerMessage;
}

function run(
  projection: TurnProjection,
  messages: readonly ServerMessage[],
): readonly OutboundDraft[] {
  return messages.flatMap((message) => [...projection.project(message)]);
}

const start = (): ServerMessage =>
  event({
    type: 'turn.start',
    agentId: 'default',
    sessionKey: 'telegram:1',
    turnId: TURN,
    model: 'm',
    provider: 'p',
  });

const delta = (text: string): ServerMessage =>
  event({ type: 'assistant.delta', turnId: TURN, text });

const end = (
  stopReason: 'complete' | 'aborted' | 'max_iterations' | 'error' = 'complete',
): ServerMessage => event({ type: 'turn.end', turnId: TURN, stopReason, iterations: 1 });

const call = (name: string, callId = 'c1'): ServerMessage =>
  event({ type: 'tool.call', turnId: TURN, callId, name, args: {}, risk: 'safe' });

describe('TurnProjection', () => {
  it('emits one reply carrying the whole answer', () => {
    const drafts = run(new TurnProjection(), [start(), delta('Hel'), delta('lo'), end()]);

    expect(drafts).toEqual([{ kind: 'reply', text: 'Hello', turnId: TURN }]);
  });

  it('never emits the reasoning stream', () => {
    const drafts = run(new TurnProjection(), [
      start(),
      event({ type: 'reasoning.delta', turnId: TURN, text: 'the user probably wants…' }),
      delta('Yes.'),
      end(),
    ]);

    expect(drafts).toEqual([{ kind: 'reply', text: 'Yes.', turnId: TURN }]);
  });

  it('sends the answer so far at a tool boundary when progress is on', () => {
    const drafts = run(new TurnProjection({ sendProgress: true }), [
      start(),
      delta('Reading the file'),
      call('read_file'),
      delta(' — done.'),
      end(),
    ]);

    expect(drafts).toEqual([
      { kind: 'progress', text: 'Reading the file', turnId: TURN },
      { kind: 'reply', text: 'Reading the file — done.', turnId: TURN },
    ]);
  });

  it('sends no progress before the model has written anything', () => {
    const drafts = run(new TurnProjection({ sendProgress: true }), [start(), call('read_file')]);

    expect(drafts).toEqual([]);
  });

  it('names the tool only when hints are on', () => {
    const off = run(new TurnProjection(), [start(), call('exec')]);
    const on = run(new TurnProjection({ sendProgress: false, sendToolHints: true }), [
      start(),
      call('exec'),
      event({
        type: 'tool.result',
        turnId: TURN,
        callId: 'c1',
        ok: false,
        content: 'exit 1',
        truncated: false,
        durationMs: 2,
      }),
    ]);

    expect(off).toEqual([]);
    expect(on).toEqual([
      { kind: 'notice', text: 'Running exec…', turnId: TURN },
      { kind: 'notice', text: 'exec failed.', turnId: TURN },
    ]);
  });

  it('announces an approval request whether or not hints are on', () => {
    const drafts = run(new TurnProjection({ sendToolHints: false }), [
      start(),
      event({
        type: 'tool.approvalRequest',
        turnId: TURN,
        callId: 'c1',
        name: 'exec',
        args: {},
        risk: 'exec',
        expiresAtMs: 1,
      }),
    ]);

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe('notice');
    expect(drafts[0]?.text).toContain('exec needs approval');
  });

  it('says why a turn stopped, after handing over what it had written', () => {
    const drafts = run(new TurnProjection(), [start(), delta('Half an ans'), end('aborted')]);

    expect(drafts).toEqual([
      { kind: 'reply', text: 'Half an ans', turnId: TURN },
      { kind: 'notice', text: 'Stopped.', turnId: TURN },
    ]);
  });

  it('reports a turn that produced nothing rather than staying silent', () => {
    const drafts = run(new TurnProjection(), [start(), end()]);

    expect(drafts).toEqual([
      { kind: 'notice', text: 'The turn finished without an answer.', turnId: TURN },
    ]);
  });

  it('does not restate an error the hub already sent', () => {
    const drafts = run(new TurnProjection(), [
      start(),
      event({
        type: 'error',
        code: 'provider_error',
        message: 'upstream said no',
        retryable: true,
      }),
      end('error'),
    ]);

    expect(drafts).toEqual([{ kind: 'error', text: 'upstream said no', turnId: TURN }]);
  });

  it('reports the iteration cap, which a partial answer otherwise hides', () => {
    const drafts = run(new TurnProjection(), [start(), delta('so far…'), end('max_iterations')]);

    expect(drafts.map((draft) => draft.kind)).toEqual(['reply', 'notice']);
    expect(drafts[1]?.text).toContain('tool-iteration limit');
  });

  it('reports a queued message with its depth', () => {
    const drafts = run(new TurnProjection(), [
      event({ type: 'message.queued', sessionKey: 'telegram:1', queueDepth: 1 }),
      event({ type: 'message.queued', sessionKey: 'telegram:1', queueDepth: 2 }),
    ]);

    expect(drafts.map((draft) => draft.text)).toEqual([
      'Queued behind 1 message.',
      'Queued behind 2 messages.',
    ]);
  });

  it('forwards a notice as written, so an injection badge is not lost', () => {
    const drafts = run(new TurnProjection(), [
      start(),
      event({
        type: 'notice',
        kind: 'prompt_injection',
        message: 'A tool result contained instructions.',
        turnId: TURN,
      }),
    ]);

    expect(drafts).toEqual([
      { kind: 'notice', text: 'A tool result contained instructions.', turnId: TURN },
    ]);
  });

  it('drops the answer at a turn boundary, so the next reply is not a transcript', () => {
    const projection = new TurnProjection();
    run(projection, [start(), delta('first'), end()]);
    const second = run(projection, [start(), delta('second'), end()]);

    expect(projection.answer).toBe('');
    expect(second).toEqual([{ kind: 'reply', text: 'second', turnId: TURN }]);
  });

  it('ignores the frames a browser uses to reconcile itself', () => {
    const drafts = run(new TurnProjection(), [
      event({
        type: 'connected',
        workspaceId: 'default',
        protocolVersion: 2,
        sessionKey: 's',
        serverTimeMs: 0,
        lastSeq: 0,
      }),
      event({ type: 'pong', serverTimeMs: 0 }),
      event({ type: 'message.ack', sessionKey: 's', messageId: 'm1' }),
      event({
        type: 'session.status',
        workspaceId: 'default',
        sessionKey: 's',
        busy: true,
        queueDepth: 0,
      }),
      event({ type: 'session.replay', sessionKey: 's', messages: [], complete: true }),
      event({ type: 'session.reset', sessionKey: 's' }),
      event({ type: 'steer', sessionKey: 's', content: 'actually…' }),
      event({ type: 'tools.changed', tools: [] }),
      event({ type: 'transcribe.result', text: 'hi' }),
      event({ type: 'tool.progress', turnId: TURN, callId: 'c1', elapsedMs: 15_000 }),
      event({
        type: 'notification',
        id: 'n1',
        title: 't',
        body: '',
        level: 'info',
        createdAtMs: 0,
      }),
    ]);

    expect(drafts).toEqual([]);
  });
});
