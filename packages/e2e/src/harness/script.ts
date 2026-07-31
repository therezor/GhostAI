/**
 * What the model says, and the one tool that exists only for these tests.
 *
 * Every spec drives the app by typing a sentence, so the sentences are the API
 * of this file: `stream a long answer` gets prose and a code fence, `list the
 * workspace` gets a tool card, `run the version command` gets an approval
 * prompt, `wait for me` gets a turn that stays in flight until something ends
 * it. A spec that types anything else gets `Ready.` — a fallback rather than a
 * throw, because most screens boot a session without ever sending a message.
 *
 * The three tools are chosen for their risk bands, not their usefulness:
 *
 *  - `list_dir` is `safe`, so it runs unattended and produces a tool card with
 *    nothing in front of it.
 *  - `exec` is `ask`, so it produces the approval prompt. Both the approve and
 *    the deny path continue into the same second turn.
 *  - `e2e_wait` is the harness's own, and it exists because "Stop aborts
 *    mid-tool" and "a reload rebuilds an in-flight turn" both need a tool that
 *    is reliably still running a moment after it started. Sleeping on a real
 *    binary would make those two assertions depend on `sleep(1)` resolving the
 *    way this machine's coreutils resolve it; waiting on the turn's own signal
 *    depends on nothing.
 */

import { abortedError } from '@ghostai/core';
import { defineTool, type AnyTool } from '@ghostai/tools';
import { z } from 'zod';

import { toolCall, type Route } from './provider.js';

/**
 * A tool that finishes when it is told to, and not before.
 *
 * `risk: 'safe'` on purpose: the approval prompt is the subject of its own
 * spec, and a Stop test that had to approve a tool first would be asserting two
 * things and failing for either.
 */
export const waitTool: AnyTool = defineTool({
  name: 'e2e_wait',
  description: 'Wait for a while, then report that the wait finished.',
  schema: z.strictObject({
    ms: z.coerce.number().int().min(0).describe('How long to wait, in milliseconds.'),
  }),
  risk: 'safe',
  annotations: { title: 'Wait', readOnlyHint: true, destructiveHint: false },
  async execute(args, context) {
    const { signal } = context;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, args.ms);
      const abort = (): void => {
        clearTimeout(timer);
        reject(abortedError('e2e_wait'));
      };
      function finish(): void {
        signal.removeEventListener('abort', abort);
        resolve();
      }
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
    });
    return `waited ${args.ms.toString()}ms`;
  },
});

/**
 * A turn that produces no events until the turn is aborted.
 *
 * `scriptedProvider` awaits `onStream` before its first event and then checks
 * the request's signal, so a promise that never settles on its own becomes "the
 * model is thinking" for exactly as long as the client leaves it there.
 * `routedProvider` races this against the request's `AbortSignal`, which is why
 * it does not need a timeout of its own.
 */
const never = (): Promise<void> => new Promise<void>(() => undefined);

/** The answer whose markdown exercises the block splitter and the highlighter. */
const LONG_ANSWER: readonly string[] = [
  'Here is what I found.\n\n',
  'The workspace holds a single note file. ',
  'Reading it back is one line:\n\n',
  '```ts\n',
  "const note = await readFile('notes.md', 'utf8');\n",
  'console.log(note.trim());\n',
  '```\n\n',
  'That is the whole of it.',
];

/**
 * What the caller asks its subagent for.
 *
 * Exported because the spec asserts it: the task is the argument on the
 * delegating card *and* the sentence that routes the subagent's own turn, and a
 * test that restated it would keep passing after the two drifted apart.
 */
export const SUBAGENT_TASK = 'find the note file';

export const ROUTES: readonly Route[] = [
  {
    // Prose, a fenced block and a reasoning trace: the three things the
    // transcript renders differently from each other.
    match: /\bstream\b/i,
    turns: [
      {
        reasoning: ['Checking the workspace', ' before answering.'],
        deltas: LONG_ANSWER,
        usage: { promptTokens: 412, completionTokens: 96, totalTokens: 508 },
      },
    ],
  },
  {
    // `list_dir` is `safe`, so the card appears with no prompt in front of it.
    match: /\blist\b/i,
    turns: [
      { toolCalls: [toolCall('call-list', 'list_dir', { path: '.' })] },
      { deltas: ['The workspace holds ', '`notes.md`.'] },
    ],
  },
  {
    // `exec` is `ask`. Approve and deny both land on the second turn — the
    // difference is what the tool result says, which is the model's problem and
    // not the transport's.
    match: /\brun\b/i,
    turns: [
      { toolCalls: [toolCall('call-exec', 'exec', { argv: ['node', '--version'] })] },
      { deltas: ['That is the runtime version.'] },
    ],
  },
  {
    // In flight until Stop, or until the reload spec has finished reloading.
    match: /\bwait\b/i,
    turns: [
      { toolCalls: [toolCall('call-wait', 'e2e_wait', { ms: 60_000 })] },
      { deltas: ['The wait finished.'] },
    ],
  },
  {
    // No tool at all — the turn stalls in the provider itself, which is the
    // shortest path to "a turn is running" for a spec that only needs the
    // composer to be showing Stop.
    match: /\bstall\b/i,
    turns: [{ onStream: never, deltas: ['Unreachable unless the stall ends.'] }],
  },
  {
    // The caller's half of a delegation. It hands the researcher a task and
    // then answers from whatever comes back.
    match: /\bdelegate\b/i,
    turns: [
      { toolCalls: [toolCall('call-sub', 'ask_researcher', { task: SUBAGENT_TASK })] },
      { deltas: ['The researcher found ', '`notes.md`.'] },
    ],
  },
  {
    // The subagent's half, and it needs no new harness concept: a subagent's
    // first user message *is* the task string, so it routes here exactly as the
    // caller's message routes above. The word is chosen not to collide with any
    // route before it — a task containing "list" would take the `list_dir`
    // route and the delegation would silently test something else.
    match: /\bfind\b/i,
    turns: [
      { toolCalls: [toolCall('call-nested', 'list_dir', { path: '.' })] },
      { deltas: ['There is one file: ', '`notes.md`.'] },
    ],
  },
];
