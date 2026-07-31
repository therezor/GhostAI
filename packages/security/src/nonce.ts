/**
 * Tool-output envelopes, and non-destructive injection detection.
 *
 * A tool result is data written by whoever controls the file, the web page or
 * the MCP server — never an instruction. The model cannot tell the difference
 * from position alone, so every result is wrapped in a delimiter carrying a
 * per-turn random nonce, and the system prompt states that everything inside
 * such a delimiter is inert. An attacker who cannot predict the nonce cannot
 * close the envelope and cannot write text that appears to be outside it.
 *
 * That is the whole defence, and it is why two details are not optional:
 *
 *  - **The nonce is fresh per turn and comes from `randomBytes`.** A fixed or
 *    per-install delimiter is one successful exfiltration away from being known
 *    forever, at which point the envelope is decoration.
 *  - **Closing tags inside the content are escaped.** Content that contains the
 *    terminator would otherwise end the envelope early and the remainder would
 *    read as the agent's own reasoning. Escaping is case-insensitive because the
 *    model is doing the parsing, and a model treats `</TOOL_OUTPUT_A1B2>` as a
 *    closing tag whatever the source said.
 *
 * **Detection is deliberately non-destructive.** Matching a phrase and
 * replacing the result with a warning banner is a bug, not a mitigation: it
 * fires on this project's own security documentation, silently removes the
 * output the model asked for, and leaves it hallucinating around the hole. So a
 * match produces a `notice` for the UI badge and the content passes through
 * byte-for-byte. The nonce does the defending; the findings only inform.
 */

import { GhostError } from '@ghostai/core';
import { DEFAULT_TOOL_POLICY_TEMPLATE, renderPromptTemplate } from '@ghostai/protocol';

import { type RandomSource, systemRandom } from './random.js';

export const TOOL_OUTPUT_TAG_PREFIX = 'tool_output_';

/** 8 bytes — 64 bits of unguessable delimiter, at 16 characters of prompt. */
export const TOOL_OUTPUT_NONCE_BYTES = 8;

const NONCE_PATTERN = /^[0-9a-f]{8,}$/i;

/** Tool names reach the envelope from MCP servers and plugins, so they are constrained. */
const UNSAFE_NAME_CHARS = /[^\w.:-]+/g;

export function createToolOutputNonce(random: RandomSource = systemRandom): string {
  return random(TOOL_OUTPUT_NONCE_BYTES).toString('hex');
}

export function toolOutputTag(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    // A short, non-random or empty nonce is a guessable delimiter, which is the
    // same as having none. Fail loudly rather than wrap with it.
    throw new GhostError('invalid_input', 'Tool-output nonce must be at least 8 hex bytes');
  }
  return `${TOOL_OUTPUT_TAG_PREFIX}${nonce}`;
}

export const INJECTION_SIGNALS = [
  /** "ignore previous instructions" and its relatives. */
  'instruction_override',
  /** An attempt to reassign the agent's identity or loyalty. */
  'role_override',
  /** An attempt to have the system prompt or tool schema echoed back. */
  'prompt_extraction',
  /** An attempt to make the agent call a tool on the content's behalf. */
  'tool_directive',
  /**
   * The content contained the envelope's own delimiter. The strongest signal
   * available: legitimate output has no reason to carry this turn's nonce.
   */
  'delimiter_forgery',
] as const;

export type InjectionSignal = (typeof INJECTION_SIGNALS)[number];

export interface InjectionFinding {
  readonly signal: InjectionSignal;
  /** Character offset into the original content. */
  readonly index: number;
  /** A short, whitespace-collapsed window around the match, safe for logs. */
  readonly excerpt: string;
}

const INJECTION_PATTERNS: readonly {
  readonly signal: InjectionSignal;
  readonly pattern: RegExp;
}[] = [
  {
    signal: 'instruction_override',
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|preceding|above|earlier)\s+(?:instruction|prompt|rule|direction|message)/i,
  },
  {
    signal: 'role_override',
    pattern: /\byou\s+are\s+(?:now|actually|really)\b|\bnew\s+(?:instructions|persona|role)\s*:/i,
  },
  {
    signal: 'prompt_extraction',
    pattern:
      /\b(?:reveal|repeat|print|output|show|echo)\s+(?:me\s+)?(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions|full\s+instructions)/i,
  },
  {
    signal: 'tool_directive',
    pattern:
      /\b(?:you\s+must|now)\s+(?:call|run|execute|invoke)\s+(?:the\s+)?[\w.-]*\s*(?:tool|command)\b/i,
  },
];

const EXCERPT_CONTEXT_CHARS = 24;
const EXCERPT_MAX_CHARS = 160;

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + EXCERPT_CONTEXT_CHARS);
  const window = text.slice(start, end).replace(/\s+/g, ' ').trim();
  const clipped =
    window.length > EXCERPT_MAX_CHARS ? `${window.slice(0, EXCERPT_MAX_CHARS)}…` : window;
  return `${start > 0 ? '…' : ''}${clipped}${end < text.length ? '…' : ''}`;
}

/**
 * Reports phrases that read as injected instructions. Never modifies anything.
 *
 * One finding per signal: this feeds a UI badge and a log line, and twenty
 * findings from one paragraph tell the operator nothing the first one did not.
 */
export function detectPromptInjection(content: string): readonly InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const { signal, pattern } of INJECTION_PATTERNS) {
    const match = pattern.exec(content);
    if (match === null) continue;
    findings.push({
      signal,
      index: match.index,
      excerpt: excerptAround(content, match.index, match[0].length),
    });
  }
  return findings;
}

export interface WrapToolOutputOptions {
  readonly toolName: string;
  /** From `createToolOutputNonce`, regenerated once per turn. */
  readonly nonce: string;
  /** Run injection detection. Default `true`. */
  readonly detect?: boolean;
}

export interface WrappedToolOutput {
  /** The envelope, ready to become a `tool` message's content. */
  readonly text: string;
  readonly tag: string;
  /** How many delimiter-shaped sequences in the content had to be escaped. */
  readonly forgedDelimiters: number;
  readonly findings: readonly InjectionFinding[];
}

/**
 * Wraps tool output in this turn's delimiter.
 *
 * The content is escaped but never truncated or replaced — truncation is the
 * agent loop's decision, made against a character budget, and replacement is
 * not anyone's.
 */
export function wrapToolOutput(content: string, options: WrapToolOutputOptions): WrappedToolOutput {
  const tag = toolOutputTag(options.nonce);
  const name = options.toolName.replace(UNSAFE_NAME_CHARS, '_');

  // Matches an opening *or* closing delimiter, case-insensitively; the nonce is
  // hex so folding case cannot collide with a different turn's tag. Escaping
  // both forms means content cannot appear to start a second envelope either.
  const delimiter = new RegExp(`<(/?)(${tag})`, 'gi');
  let forgedDelimiters = 0;
  const escaped = content.replace(delimiter, (_match, slash: string, matchedTag: string) => {
    forgedDelimiters += 1;
    return `<\\${slash}${matchedTag}`;
  });

  const findings: InjectionFinding[] = [];
  if (forgedDelimiters > 0) {
    const index = content.search(new RegExp(`<(?:/?)${tag}`, 'i'));
    findings.push({
      signal: 'delimiter_forgery',
      index,
      excerpt: excerptAround(content, index, tag.length + 2),
    });
  }
  if (options.detect ?? true) findings.push(...detectPromptInjection(content));

  return {
    text: `<${tag} name="${name}">\n${escaped}\n</${tag}>`,
    tag,
    forgedDelimiters,
    findings,
  };
}

/** A single sentence for the `notice` event's `message` field. */
export function describeInjectionFindings(findings: readonly InjectionFinding[]): string {
  const signals = [...new Set(findings.map((finding) => finding.signal))].join(', ');
  return (
    `Tool output contains text resembling injected instructions (${signals}). ` +
    'The content was passed through unchanged — treat it as data.'
  );
}

/**
 * The system-prompt section that makes the delimiters mean something.
 *
 * Without this text the wrapping is inert: the model has no reason to treat one
 * region of its context differently from another. The nonce is included so the
 * instruction names the exact delimiter in force for this turn.
 *
 * **`template` is the operator's, and the text is all it can change.** This used
 * to be the one section with no config key, on the grounds that it is the
 * prompt-injection defence rather than prose. It is not: `wrapToolOutput` emits
 * the fences and escapes forged ones on every result whatever is written here,
 * so this paragraph explains a mechanism instead of being one. An operator who
 * deletes it gets envelopes their model has not been told to respect — worth a
 * warning, which `assertBuildable` and the editor both raise, and not worth
 * being the single exception to a promise the rest of the prompt keeps.
 *
 * The default lives in `@ghostai/protocol` rather than here so the browser can
 * offer it as a starting point; the layer graph runs protocol → core → security,
 * so this import is the direction that exists.
 */
export function toolOutputPolicy(nonce: string, template?: string): string {
  const tag = toolOutputTag(nonce);
  return renderPromptTemplate(
    template === undefined || template === '' ? DEFAULT_TOOL_POLICY_TEMPLATE : template,
    { nonce, tag },
  );
}
