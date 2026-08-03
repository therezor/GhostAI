/**
 * The heartbeat's decide / run / evaluate triad.
 *
 * A heartbeat reads a task file on an interval and decides whether there is
 * anything to do. Two of its three steps are **not agent turns** — they are
 * single provider requests carrying one tool with `toolChoice: 'required'`,
 * which is the caller `ToolChoice`'s own doc comment in `@ghostai/providers`
 * was written for.
 *
 * That is a deliberate refusal of the obvious design. Registering a `heartbeat`
 * tool in the shared `ToolRegistry` would leak it into every ordinary chat turn
 * and into every subagent's, and `unregisterBySource` is per-source, so hiding
 * it again would need a fourth `ToolSource` invented for one yes/no. Worse, an
 * agent turn for a classification writes a user message and an assistant
 * message into a session — forever, every thirty minutes.
 *
 * So only the middle step is a turn. This module is everything around it, and
 * it is pure: every function takes and returns plain values, which is what lets
 * the interesting half — what happens when a cheap model answers badly — be
 * tested from a `ChatResult` literal rather than a live endpoint.
 *
 * **The failure rule is fail-closed on acting, fail-loud on reporting.** A
 * decision that cannot be read becomes `skipped` with a warning, never a run.
 * The alternative — defaulting to `run` — is an unbounded agent turn started on
 * garbage every thirty minutes, billed to the operator, and the model that
 * produced the garbage is by construction the cheapest one in the install.
 */

import { z } from 'zod';
import type {
  AssistantMessage,
  ChatMessage,
  ToolDefinition,
} from '@ghostai/protocol';
import type { ChatResult } from '@ghostai/providers';

/** How much of a task file is worth paying to classify, every interval, forever. */
export const MAX_TASK_FILE_BYTES: number = 64 * 1024;

/** `skipReason` goes in a column and onto a card; the model does not know that. */
export const MAX_REASON_LENGTH = 256;

/**
 * What the model is told to send instead of prose.
 *
 * `instruction` is optional on purpose: the model's job here is the decision,
 * and a missing phrasing is not a reason to refuse a `run` it did commit to.
 */
export const HEARTBEAT_TOOL: ToolDefinition = {
  name: 'heartbeat',
  description: 'Decide whether the task file asks for work right now.',
  risk: 'safe',
  source: 'builtin',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'reason'],
    properties: {
      action: {
        type: 'string',
        enum: ['skip', 'run'],
        description:
          'run only when the file asks for something that is due now.',
      },
      reason: {
        type: 'string',
        description:
          'One sentence: why there is nothing to do, or what is due.',
      },
      instruction: {
        type: 'string',
        description: 'When action is run: the message to send to the agent.',
      },
    },
  },
};

/** The second decision: whether the run's result is worth interrupting anyone. */
export const HEARTBEAT_RESULT_TOOL: ToolDefinition = {
  name: 'heartbeat_result',
  description:
    'Decide whether what the agent did is worth telling the user about.',
  risk: 'safe',
  source: 'builtin',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['notify', 'title'],
    properties: {
      notify: {
        type: 'boolean',
        description: 'Whether this is worth interrupting the user for.',
      },
      title: {
        type: 'string',
        description: 'A short headline, under ten words.',
      },
      summary: { type: 'string', description: 'One or two sentences.' },
    },
  },
};

const DecisionArgumentsSchema = z.object({
  action: z.enum(['skip', 'run']),
  reason: z.string().default(''),
  instruction: z.string().optional(),
});

const EvaluationArgumentsSchema = z.object({
  notify: z.boolean(),
  title: z.string().min(1),
  summary: z.string().optional(),
});

export type HeartbeatAction = 'skip' | 'run';

export interface HeartbeatDecision {
  readonly action: HeartbeatAction;
  /** Populated for both outcomes; becomes `skipReason` on a skip. */
  readonly reason: string;
  /** What to send the agent. Always present when `action` is `run`. */
  readonly instruction: string;
  /** Non-empty when the model answered badly enough to be worth recording. */
  readonly warnings: readonly string[];
}

export interface HeartbeatEvaluation {
  readonly notify: boolean;
  readonly title: string;
  readonly summary: string;
  readonly warnings: readonly string[];
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** The first tool call by name, or undefined. */
function toolCallNamed(
  message: AssistantMessage,
  name: string,
): string | undefined {
  for (const call of message.toolCalls) {
    if (call.name === name) return call.argumentsJson;
  }
  return undefined;
}

/** The prose half of an answer, for the case where that is all there is. */
function textOf(message: AssistantMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

export interface DecideMessagesInput {
  /** Workspace-relative, for the model's benefit and the reason text. */
  readonly file: string;
  readonly contents: string;
  /** Formatted for the model, so "tomorrow" in a task file means something. */
  readonly nowIso: string;
}

export function buildDecideMessages(input: DecideMessagesInput): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You decide whether a task file asks for work right now. ' +
        `The current time is ${input.nowIso}. ` +
        'Answer only by calling the heartbeat tool — never with prose. ' +
        'Choose skip unless something in the file is actually due: this runs on a ' +
        'timer forever, and a run that was not needed costs the user real money ' +
        'and a real interruption.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Task file \`${input.file}\`:\n\n\`\`\`\n${input.contents}\n\`\`\``,
        },
      ],
    },
  ];
}

/**
 * Reads the decision out of a completion.
 *
 * Every failure lands on `skip`, and each carries a warning so the run history
 * says why rather than showing an unexplained no-op.
 *
 * The no-tool-call branch is not defensive programming — it **will** happen.
 * `withResilience`'s `drop_tool_choice` rung strips `toolChoice: 'required'`
 * and retries whenever a provider objects to it, so a model that answers in
 * prose is a normal outcome of a normal degradation, not a broken install.
 */
export function readDecision(
  result: ChatResult,
  file: string,
): HeartbeatDecision {
  const argumentsJson = toolCallNamed(result.message, HEARTBEAT_TOOL.name);

  if (argumentsJson === undefined) {
    return {
      action: 'skip',
      reason: 'The model did not answer with a decision.',
      instruction: '',
      warnings: [
        'The heartbeat model answered without calling the decision tool, so this interval was skipped.',
      ],
    };
  }

  const parsed = DecisionArgumentsSchema.safeParse(parseJson(argumentsJson));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail =
      issue === undefined
        ? 'unreadable'
        : `${issue.path.join('.')} ${issue.message}`;
    return {
      action: 'skip',
      reason: `The model's decision could not be read (${detail}).`,
      instruction: '',
      warnings: [
        `The heartbeat model sent arguments that did not parse: ${detail}.`,
      ],
    };
  }

  const { action, reason, instruction } = parsed.data;
  if (action === 'skip') {
    return {
      action: 'skip',
      reason: truncate(
        reason === '' ? 'Nothing due.' : reason,
        MAX_REASON_LENGTH,
      ),
      instruction: '',
      warnings: [],
    };
  }

  // A `run` with no phrasing still runs. The model committed to the decision;
  // only the wording was missing, and refusing on that would turn a working
  // heartbeat into one that silently never acts.
  const missing = instruction === undefined || instruction.trim() === '';
  return {
    action: 'run',
    reason: truncate(
      reason === '' ? 'The task file asks for work.' : reason,
      MAX_REASON_LENGTH,
    ),
    instruction: missing
      ? `Read \`${file}\` and do what it asks.`
      : instruction,
    warnings: missing
      ? [
          'The heartbeat model chose to run without saying what to do; the task file was used as-is.',
        ]
      : [],
  };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

export interface EvaluateMessagesInput {
  readonly instruction: string;
  readonly output: string;
}

export function buildEvaluateMessages(
  input: EvaluateMessagesInput,
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You decide whether an unattended agent run is worth interrupting someone about. ' +
        'Answer only by calling the heartbeat_result tool. ' +
        'Choose notify only for something the user would want to know now — work ' +
        'finished, a decision needed, something broken. Routine progress is not worth a notification.',
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `The agent was asked:\n${input.instruction}\n\nIt answered:\n${input.output}`,
        },
      ],
    },
  ];
}

/**
 * Reads the evaluation, defaulting to **notifying**.
 *
 * The opposite default to `readDecision`, and for a symmetric reason: there,
 * failing open costs an unwanted agent turn; here it costs a toast. A
 * notification nobody needed is a minor annoyance, and a finished run nobody
 * was told about is invisible — so the cheap mistake is the one to make.
 */
export function readEvaluation(
  result: ChatResult,
  fallbackTitle: string,
): HeartbeatEvaluation {
  const argumentsJson = toolCallNamed(
    result.message,
    HEARTBEAT_RESULT_TOOL.name,
  );
  const parsed =
    argumentsJson === undefined
      ? undefined
      : EvaluationArgumentsSchema.safeParse(parseJson(argumentsJson));

  if (parsed?.success !== true) {
    return {
      notify: true,
      title: fallbackTitle,
      summary: textOf(result.message),
      warnings: [
        'The heartbeat model did not say whether this was worth a notification.',
      ],
    };
  }

  return {
    notify: parsed.data.notify,
    title: truncate(parsed.data.title, MAX_REASON_LENGTH),
    summary: parsed.data.summary ?? '',
    warnings: [],
  };
}
