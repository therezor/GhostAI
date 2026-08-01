import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import type { AgentEvent, AgentLoop, TurnInput } from '@ghostai/agent';
import { SessionStore, hasOrphanedToolResult } from '@ghostai/core';
import type { FetchImplementation } from '@ghostai/security';
import { afterEach, describe, expect, it } from 'vitest';

import { SIGINT_EXIT_CODE, chatCommand, runTurn } from './chat.js';
import { TurnRenderer, type RenderTarget } from './render.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-chat-'));
  homes.push(dir);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  return dir;
}

afterEach(() => {
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Collects writes. Only `write` is reached on the paths under test. */
function sink(): NodeJS.WritableStream & { text: string } {
  const target = {
    text: '',
    write(chunk: string): boolean {
      target.text += chunk;
      return true;
    },
  };
  return target as unknown as NodeJS.WritableStream & { text: string };
}

/**
 * `FetchImplementation` is typed against undici's `Response`, which this package
 * does not depend on. Node's global `Response` *is* undici's at runtime — the
 * runtime embeds it — so this is a declaration-level detail, not a fiction.
 */
function transport(...responses: readonly (Response | (() => Promise<never>))[]): {
  fetchImpl: FetchImplementation;
  bodies: Record<string, unknown>[];
} {
  const queue = [...responses];
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = async (_url: string, init: { body?: unknown }): Promise<Response> => {
    bodies.push(
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    );
    const next = queue.shift();
    if (next === undefined) throw new Error('unscripted request');
    return typeof next === 'function' ? await next() : next;
  };
  return { fetchImpl: fetchImpl as unknown as FetchImplementation, bodies };
}

function sse(...frames: readonly unknown[]): Response {
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function toolCallFrame(id: string, name: string, argumentsJson: string): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id, function: { name, arguments: argumentsJson } }] },
      },
    ],
  };
}

function textFrame(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text } }] };
}

function finishFrame(reason: string): unknown {
  return { choices: [{ index: 0, delta: {}, finish_reason: reason }] };
}

const USAGE = { choices: [], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } };

/** A loop whose whole behaviour is the generator handed to it. */
function fakeLoop(run: (input: TurnInput) => AsyncGenerator<AgentEvent, unknown>): AgentLoop {
  return { run } as unknown as AgentLoop;
}

function renderer(out: RenderTarget): TurnRenderer {
  return new TurnRenderer({ out, colors: false });
}

/** A real stream, for the REPL: readline attaches listeners to its output. */
function streamSink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { stream, text: () => text };
}

/** Polls rather than sleeping a fixed amount: the REPL answers when it answers. */
/**
 * Writes one line and waits for the prompt to come back.
 *
 * Waiting only for a command's *output* is a race: the renderer writes it from
 * inside the dispatcher, several ticks before the REPL loops round to
 * `rl.question` again — and a line written into that gap is dropped by readline
 * rather than queued. Counting the prompt is what makes a sequence of commands
 * deterministic.
 */
async function send(
  input: { write: (chunk: string) => unknown },
  out: { text: () => string },
  line: string,
  expected: string,
): Promise<void> {
  input.write(`${line}\n`);
  // Both halves are needed, in this order. The text says the command ran; the
  // settle says the REPL is back at its prompt. Waiting only for the text
  // writes the next line into the gap before `rl.question` is called again,
  // where readline drops it rather than queueing it — and a dropped line looks
  // exactly like a command that did nothing. Settling *first* is no good
  // either: a turn's output pauses between SSE frames, and a mid-turn lull
  // reads as idle.
  await waitFor(() => out.text().includes(expected), 20_000);
  await quiet(out);
}

/** Resolves once the output has stopped changing — the REPL is back at a prompt. */
async function quiet(out: { text: () => string }, stillMs = 40): Promise<void> {
  let last = '';
  let since = Date.now();
  const deadline = Date.now() + 20_000;

  for (;;) {
    const current = out.text();
    if (current !== last) {
      last = current;
      since = Date.now();
    } else if (Date.now() - since >= stillMs) {
      return;
    }
    if (Date.now() > deadline) throw new Error('the prompt never went quiet');
    await new Promise((done) => setTimeout(done, 5));
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the prompt');
    await new Promise((done) => setTimeout(done, 5));
  }
}

// ---------------------------------------------------------------------------

describe('runTurn', () => {
  const buffer = (): RenderTarget & { text: string } => ({
    text: '',
    write(chunk: string): void {
      this.text += chunk;
    },
  });

  it('renders the stream and reports the loop’s own stop reason', async () => {
    const out = buffer();
    const loop = fakeLoop(async function* () {
      yield {
        type: 'turn.start',
        agentId: 'default',
        sessionKey: 's',
        turnId: 't1',
        model: 'm',
        provider: 'p',
      } satisfies AgentEvent;
      yield { type: 'assistant.delta', turnId: 't1', text: 'Hi.' } satisfies AgentEvent;
      yield {
        type: 'turn.end',
        turnId: 't1',
        stopReason: 'complete',
        iterations: 1,
      } satisfies AgentEvent;
      return undefined;
    });

    const outcome = await runTurn(
      { loop, renderer: renderer(out), sessionKey: 's', signal: new AbortController().signal },
      'hello',
    );

    expect(outcome).toEqual({ stopReason: 'complete', aborted: false, failed: false });
    expect(out.text).toContain('Hi.');
  });

  it('reports a turn that stopped at a cap without calling it a failure', async () => {
    const loop = fakeLoop(async function* () {
      yield {
        type: 'turn.end',
        turnId: 't1',
        stopReason: 'max_iterations',
        iterations: 40,
      } satisfies AgentEvent;
      return undefined;
    });

    const outcome = await runTurn(
      {
        loop,
        renderer: renderer(buffer()),
        sessionKey: 's',
        signal: new AbortController().signal,
      },
      'go',
    );
    expect(outcome).toEqual({ stopReason: 'max_iterations', aborted: false, failed: false });
  });

  it('threads the signal into the loop and reports the abort', async () => {
    const controller = new AbortController();
    const loop = fakeLoop(async function* (input) {
      yield {
        type: 'turn.start',
        agentId: 'default',
        sessionKey: 's',
        turnId: 't1',
        model: 'm',
        provider: 'p',
      } satisfies AgentEvent;
      await new Promise<void>((done) => {
        // The listener has to tolerate an abort that already happened: the
        // generator body does not start until the first `next()`, so a caller
        // aborting immediately would otherwise wait forever.
        if (input.signal?.aborted === true) {
          done();
          return;
        }
        input.signal?.addEventListener('abort', () => {
          done();
        });
      });
      yield {
        type: 'turn.end',
        turnId: 't1',
        stopReason: 'aborted',
        iterations: 1,
      } satisfies AgentEvent;
      return undefined;
    });

    const pending = runTurn(
      { loop, renderer: renderer(buffer()), sessionKey: 's', signal: controller.signal },
      'long job',
    );
    controller.abort();

    expect(await pending).toEqual({ stopReason: 'aborted', aborted: true, failed: false });
  });

  it('treats an abandoned generator as an abort rather than a crash', async () => {
    const loop = fakeLoop(async function* () {
      yield {
        type: 'turn.start',
        agentId: 'default',
        sessionKey: 's',
        turnId: 't1',
        model: 'm',
        provider: 'p',
      } satisfies AgentEvent;
      throw new DOMException('stopped', 'AbortError');
    });

    const outcome = await runTurn(
      {
        loop,
        renderer: renderer(buffer()),
        sessionKey: 's',
        signal: new AbortController().signal,
      },
      'x',
    );
    expect(outcome.aborted).toBe(true);
  });

  it('lets a real failure out rather than reporting a completed turn', async () => {
    const loop = fakeLoop(async function* () {
      yield {
        type: 'turn.start',
        agentId: 'default',
        sessionKey: 's',
        turnId: 't1',
        model: 'm',
        provider: 'p',
      } satisfies AgentEvent;
      throw new Error('database is locked');
    });

    await expect(
      runTurn(
        {
          loop,
          renderer: renderer(buffer()),
          sessionKey: 's',
          signal: new AbortController().signal,
        },
        'x',
      ),
    ).rejects.toThrow('database is locked');
  });

  it('emits one JSON object per event when asked to', async () => {
    const out = sink();
    const loop = fakeLoop(async function* () {
      yield { type: 'assistant.delta', turnId: 't1', text: 'Hi.' } satisfies AgentEvent;
      yield {
        type: 'turn.end',
        turnId: 't1',
        stopReason: 'complete',
        iterations: 1,
      } satisfies AgentEvent;
      return undefined;
    });

    await runTurn(
      {
        loop,
        renderer: renderer(sink()),
        sessionKey: 's',
        signal: new AbortController().signal,
        json: out,
      },
      'x',
    );

    const lines = out.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AgentEvent);
    expect(lines.map((event) => event.type)).toEqual(['assistant.delta', 'turn.end']);
  });
});

describe('chatCommand', () => {
  const base = {
    provider: 'ollama',
    model: 'test-model',
    vault: false as const,
    handleSignals: false,
    env: {},
  };

  it('runs a turn involving a tool call and persists it with pairing intact', async () => {
    const home = tempHome();
    writeFileSync(join(home, 'workspace', 'notes.md'), '# notes\n');

    const { fetchImpl, bodies } = transport(
      sse(toolCallFrame('call_1', 'list_dir', '{"path":"."}'), finishFrame('tool_calls')),
      sse(textFrame('Just notes.md'), finishFrame('stop'), USAGE),
    );
    const out = sink();

    const code = await chatCommand({
      ...base,
      home,
      fetchImpl,
      out,
      colors: false,
      message: 'what is in the workspace?',
    });

    expect(code).toBe(0);
    expect(out.text).toContain('⚙ list_dir');
    expect(out.text).toContain('Just notes.md');

    // The tool's *own* output, not the scripted answer: this is what proves the
    // jail was rooted at this run's workspace rather than at `~/.ghostai`.
    const listing = bodies[1]?.messages as { role: string; content?: unknown }[] | undefined;
    const toolMessage = listing?.find((message) => message.role === 'tool');
    expect(JSON.stringify(toolMessage?.content)).toContain('notes.md');

    // The second request carries the tool result, which is what makes this a
    // multi-iteration turn rather than two unrelated ones.
    const second = bodies[1]?.messages as { role: string }[] | undefined;
    expect(second?.map((message) => message.role)).toContain('tool');

    // Reopened from disk, because the point of the store is surviving the
    // process — and an orphaned tool result only bites on the *next* turn.
    const store = new SessionStore({ file: join(home, 'ghost.db') });
    try {
      const history = store.history('cli:default');
      expect(history.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
        'assistant',
      ]);
      expect(hasOrphanedToolResult(history)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('advertises tools to the provider, and none when told not to', async () => {
    const home = tempHome();
    const withTools = transport(sse(textFrame('ok'), finishFrame('stop'), USAGE));
    await chatCommand({
      ...base,
      home,
      fetchImpl: withTools.fetchImpl,
      out: sink(),
      message: 'hi',
    });
    expect(withTools.bodies[0]?.tools).toBeDefined();

    const without = transport(sse(textFrame('ok'), finishFrame('stop'), USAGE));
    await chatCommand({
      ...base,
      home,
      tools: false,
      fetchImpl: without.fetchImpl,
      out: sink(),
      message: 'hi',
    });
    expect(without.bodies[0]?.tools).toBeUndefined();
  });

  it('continues a session across invocations, and forgets it on --new', async () => {
    const home = tempHome();
    const first = transport(sse(textFrame('one'), finishFrame('stop'), USAGE));
    await chatCommand({ ...base, home, fetchImpl: first.fetchImpl, out: sink(), message: 'a' });

    const second = transport(sse(textFrame('two'), finishFrame('stop'), USAGE));
    await chatCommand({ ...base, home, fetchImpl: second.fetchImpl, out: sink(), message: 'b' });
    const carried = second.bodies[0]?.messages as { role: string }[] | undefined;
    // system + the first turn's user/assistant + this turn's user + the trailing
    // turn carrying live state, which is sent on every request and stored on none.
    expect(carried).toHaveLength(5);
    expect(carried?.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'user',
    ]);

    const third = transport(sse(textFrame('three'), finishFrame('stop'), USAGE));
    await chatCommand({
      ...base,
      home,
      fresh: true,
      fetchImpl: third.fetchImpl,
      out: sink(),
      message: 'c',
    });
    expect(third.bodies[0]?.messages).toHaveLength(3);
  });

  it('exits 1 on a provider failure, and writes nothing to history', async () => {
    const home = tempHome();
    const { fetchImpl } = transport(
      new Response(JSON.stringify({ error: { message: 'no key', type: 'auth' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const out = sink();

    const code = await chatCommand({ ...base, home, fetchImpl, out, colors: false, message: 'hi' });

    expect(code).toBe(1);
    expect(out.text).toContain('✖');

    // A provider 400 written into the transcript is replayed on every later
    // request, so a poisoned turn must not poison the session.
    const store = new SessionStore({ file: join(home, 'ghost.db') });
    try {
      expect(store.history('cli:default').map((message) => message.role)).toEqual(['user']);
    } finally {
      store.close();
    }
  });

  it('exits 130 when the turn is interrupted', async () => {
    const home = tempHome();
    const { fetchImpl } = transport(async () => {
      throw new DOMException('aborted', 'AbortError');
    });

    const code = await chatCommand({ ...base, home, fetchImpl, out: sink(), message: 'hi' });
    expect(code).toBe(SIGINT_EXIT_CODE);
  });

  it('does nothing for an empty message', async () => {
    const home = tempHome();
    const { fetchImpl, bodies } = transport();
    const code = await chatCommand({ ...base, home, fetchImpl, out: sink(), message: '   ' });

    expect(code).toBe(0);
    expect(bodies).toHaveLength(0);
  });

  it('reads a piped stdin as the message', async () => {
    const home = tempHome();
    const { fetchImpl, bodies } = transport(sse(textFrame('ok'), finishFrame('stop'), USAGE));
    const input = Readable.from(['what is ', 'here?'], { objectMode: false });

    const code = await chatCommand({ ...base, home, fetchImpl, out: sink(), input });

    expect(code).toBe(0);
    const messages = bodies[0]?.messages as { role: string; content: unknown }[] | undefined;
    expect(JSON.stringify(messages?.[1]?.content)).toContain('what is here?');
  });

  it('runs a session at the prompt, with slash commands beside it', async () => {
    const home = tempHome();
    const { fetchImpl } = transport(sse(textFrame('Two.'), finishFrame('stop'), USAGE));
    const out = streamSink();
    // A prompt is only opened on a terminal; a REPL on a piped stdin would read
    // its first line as a question and then hit EOF.
    const input = Object.assign(new PassThrough(), { isTTY: true });

    const pending = chatCommand({
      ...base,
      home,
      fetchImpl,
      out: out.stream,
      colors: false,
      input,
    });

    await waitFor(() => out.text().includes('/help for commands'));
    expect(out.text()).toContain('test-model @ Ollama');

    input.write('/session\n');
    await waitFor(() => out.text().includes('0 messages'));

    input.write('/nope\n');
    await waitFor(() => out.text().includes('unknown command: /nope'));

    input.write('what is one plus one?\n');
    await waitFor(() => out.text().includes('Two.'));

    input.write('/clear\n');
    await waitFor(() => out.text().includes('history cleared'));

    input.write('/exit\n');
    expect(await pending).toBe(0);
  });

  it('manages sessions, messages and workspaces from the prompt', async () => {
    const home = tempHome();
    const { fetchImpl } = transport(sse(textFrame('An answer.'), finishFrame('stop'), USAGE));
    const out = streamSink();
    const input = Object.assign(new PassThrough(), { isTTY: true });

    const pending = chatCommand({
      ...base,
      home,
      fetchImpl,
      out: out.stream,
      colors: false,
      input,
    });
    await waitFor(() => out.text().includes('› '));
    await quiet(out);

    // A session, so there is something to name, list and rework.
    await send(input, out, 'the first question', 'An answer.');
    // The usage line, not the rate: a turn this fast can measure 0 ms, and
    // `formatRate` reports nothing rather than dividing by it. That rule is
    // asserted in `render.test.ts`, where the elapsed time is a parameter
    // rather than however long the machine took.
    expect(out.text()).toContain('in / ');

    // Derived by the agent loop, which is why the CLI needed no code for it.
    await send(input, out, '/session', 'workspace default');
    expect(out.text()).toContain('the first question');
    expect(out.text()).toContain('workspace default');

    await send(input, out, '/messages', '2  assistant');
    expect(out.text()).toContain('1  user');
    expect(out.text()).toContain('2  assistant');

    await send(input, out, '/rename Renamed by hand', 'renamed to');
    expect(out.text()).toContain('renamed to Renamed by hand');

    await send(input, out, '/sessions', 'Renamed by hand  ·');
    expect(out.text()).toContain('Renamed by hand');

    await send(input, out, '/stats', 'test-model ·');
    expect(out.text()).toContain('test-model');

    await send(input, out, '/branch', 'attached to');
    expect(out.text()).toContain('branched at');
    // A branch attaches to the fork, so the next turn continues down it.
    expect(out.text()).toContain('attached to');

    await send(input, out, '/new a second session', 'attached to');
    await send(input, out, '/session', 'a second session');

    await send(input, out, '/workspaces', 'sessions');
    expect(out.text()).toContain('sessions');

    await send(input, out, '/workspace nope', 'No workspace nope');
    expect(out.text()).toContain('No workspace nope');

    input.write('/exit\n');
    expect(await pending).toBe(0);
  }, 30_000);

  it('re-runs a turn after editing what started it', async () => {
    const home = tempHome();
    // Three scripted turns, each saying something different: the original, the
    // edit's re-run, and the regenerate's. Distinct answers are what make each
    // wait unambiguous — the terminal echoes the typed line, so waiting on
    // anything the user wrote matches before the command has run. The queue is
    // one-shot, so a missing response surfaces as `unscripted request` rather
    // than as a silently repeated answer.
    const { fetchImpl } = transport(
      sse(textFrame('An answer.'), finishFrame('stop'), USAGE),
      sse(textFrame('A second answer.'), finishFrame('stop'), USAGE),
      sse(textFrame('A third answer.'), finishFrame('stop'), USAGE),
    );
    const out = streamSink();
    const input = Object.assign(new PassThrough(), { isTTY: true });

    const pending = chatCommand({
      ...base,
      home,
      fetchImpl,
      out: out.stream,
      colors: false,
      input,
    });
    await waitFor(() => out.text().includes('› '));
    await quiet(out);

    await send(input, out, 'the first question', 'An answer.');

    // Truncates, then hands the content back — so the re-run goes through the
    // same path a typed message does rather than a second copy of it.
    await send(input, out, '/edit -1 a better question', 'A second answer.');

    await send(input, out, '/regenerate', 'A third answer.');

    // Each rework replaced the exchange rather than appending one: the
    // session still holds a single question, and it is the edited wording.
    //
    // The seqs are *not* 1 and 2. `truncateAfter` deliberately leaves
    // `next_seq` alone — reusing sequence numbers would make a stale cursor
    // held by a reconnecting client address a different message — so two
    // rewrites leave a gap, and that gap is the design rather than a defect.
    await send(input, out, '/messages', 'a better question');
    expect(out.text()).toContain('user  a better question');
    expect(out.text()).toContain('assistant  A third answer.');

    input.write('/exit\n');
    expect(await pending).toBe(0);
  }, 30_000);

  it('refuses to rework a message that is not one of yours', async () => {
    const home = tempHome();
    const { fetchImpl } = transport(sse(textFrame('An answer.'), finishFrame('stop'), USAGE));
    const out = streamSink();
    const input = Object.assign(new PassThrough(), { isTTY: true });

    const pending = chatCommand({
      ...base,
      home,
      fetchImpl,
      out: out.stream,
      colors: false,
      input,
    });
    await waitFor(() => out.text().includes('› '));
    await quiet(out);

    await send(input, out, 'the first question', 'An answer.');

    // seq 2 is the assistant's answer.
    await send(input, out, '/edit 2 nope', 'is not one of yours');
    expect(out.text()).toContain('is not one of yours');

    await send(input, out, '/edit 99 nope', 'No message 99');
    expect(out.text()).toContain('No message 99');

    // A refused command leaves the session exactly as it was.
    await send(input, out, '/messages', 'the first question');
    expect(out.text()).toContain('1  user  the first question');
    expect(out.text()).toContain('2  assistant  An answer.');

    input.write('/exit\n');
    expect(await pending).toBe(0);
  }, 30_000);

  it('emits raw events in --json mode instead of prose', async () => {
    const home = tempHome();
    const { fetchImpl } = transport(sse(textFrame('ok'), finishFrame('stop'), USAGE));
    const out = sink();

    await chatCommand({ ...base, home, fetchImpl, out, json: true, message: 'hi' });

    const types = out.text
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as AgentEvent).type);
    expect(types[0]).toBe('turn.start');
    expect(types.at(-1)).toBe('turn.end');
  });
});
