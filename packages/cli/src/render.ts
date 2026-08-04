/**
 * `AgentEvent` → a terminal.
 *
 * This is the first consumer of the event stream, and it is deliberately the
 * dumbest one possible: a `switch` over `event.type` that writes strings. There
 * is no CLI-shaped variant of the loop and no `onToken` callback, because the
 * WebSocket hub in Phase 2 and the Telegram renderer in Phase 3 are the same
 * `switch` over the same union. If rendering needed anything the events do not
 * carry, that is a missing field on the event, not a reason for a second path
 * out of the loop.
 *
 * What the renderer owns, and why each is here rather than in the loop:
 *
 *  - **Line discipline.** Assistant text streams in arbitrary chunks that may or
 *    may not end on a newline, and a tool card printed straight after one would
 *    land mid-sentence. `#atLineStart` tracks the cursor so a break is emitted
 *    exactly when one is needed, and never twice.
 *  - **Colour as an injected boolean.** `pc.createColors(false)` returns the same
 *    interface with identity formatters, so tests assert on the text rather than
 *    on escape sequences, and `--no-color` is one flag rather than a branch at
 *    every call site.
 *  - **Tool output is previewed, not printed.** A result is capped at 8k chars
 *    before it reaches here; dumping that into a terminal buries the answer that
 *    follows it. The first few lines are what tells a human whether the call did
 *    what they expected.
 *
 * The one thing this must *not* do is render the nonce delimiters. `tool.result`
 * carries the tool's own output for exactly that reason — the envelope is a
 * defence mechanism aimed at a language model, and showing it to a human would
 * be displaying the lock rather than the door.
 */

import type {
  AgentEvent,
  NestedAgentEvent,
  SubagentEvent,
} from '@ghostai/agent';
import type { TurnStatsRecord } from '@ghostai/core';
import { tokensPerSecond, type ToolRisk, type Usage } from '@ghostai/protocol';
import type { Palette } from '@ghostai/tui';
import pc from 'picocolors';

import { DEFAULT_LOCALE } from '@ghostai/i18n';

import { translations, type CliKey, type CliT } from './i18n.js';

/** Anything that takes a string. `process.stdout` satisfies it; so does a test. */
export interface RenderTarget {
  write(text: string): void;
}

export interface TurnRendererOptions {
  readonly out: RenderTarget;
  /** Defaults to picocolors' own TTY/`NO_COLOR` detection. */
  readonly colors?: boolean;
  /** Reasoning deltas are dimmed rather than hidden. Default `true`. */
  readonly showReasoning?: boolean;
  /** The dim token/iteration line after a turn. Default `true`. */
  readonly showUsage?: boolean;
  /** Lines of a tool result to preview. `0` prints none. Default `6`. */
  readonly toolResultLines?: number;
  /**
   * The terminal's `t`. Defaults to English.
   *
   * Injected the same way and for the same reason as `colors`: a default that
   * behaves means a test constructs this with two fields rather than five, and
   * `chatCommand` passes the install's own locale in exactly one place.
   */
  readonly t?: CliT;
}

const DEFAULT_TOOL_RESULT_LINES = 6;

/** Ellipsis included in the budget, so a clipped string never exceeds `max`. */
export function clip(text: string, max: number): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * `JSON.stringify` is typed as returning `string`, and does not: `undefined`, a
 * function and a symbol all come back as `undefined`. A tool argument can be any
 * of those — the model's JSON is parsed as `unknown` — so the declared type is
 * widened here rather than trusted.
 */
function jsonText(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'function') return 'function';
  if (typeof value === 'symbol') return value.toString();
  return JSON.stringify(value);
}

function formatValue(value: unknown): string {
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return clip(jsonText(value), 44);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The model's arguments on one line.
 *
 * `path="src" recursive=true` rather than the raw JSON: a tool card is scanned,
 * not read, and the braces and quotes are the part carrying no information. The
 * arguments may also be a bare string — `tool.call` falls back to the raw
 * `argumentsJson` when a model emits invalid JSON, and that case is exactly the
 * one worth showing verbatim.
 */
export function summariseArgs(args: unknown, max: number = 96): string {
  if (args === undefined) return '';
  if (typeof args === 'string') return clip(args, max);
  if (!isPlainObject(args)) return clip(jsonText(args), max);

  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return clip(
    entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(' '),
    max,
  );
}

/**
 * A duration, in the terminal's denser wording.
 *
 * The hour branch is not symmetry with the web's `formatDuration` for its own
 * sake: without it a three-hour turn rendered as `180m 00s`, which is a number a
 * reader has to divide before it means anything.
 *
 * The sub-minute form stays one decimal all the way to sixty seconds, where the
 * web drops the decimal above ten. That divergence is deliberate and is the same
 * one that makes this file render `1.2k` where the web renders `8,192`: a
 * terminal line is read at a glance and a settings panel is read on purpose.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;

  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) {
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${String(totalMinutes)}m ${String(seconds).padStart(2, '0')}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  return `${String(hours)}h ${String(totalMinutes % 60).padStart(2, '0')}m`;
}

export function formatCount(value: number): string {
  return value < 1000 ? String(value) : `${(value / 1000).toFixed(1)}k`;
}

/**
 * Completion tokens per second, as a phrase, or nothing.
 *
 * `tokensPerSecond` reports `undefined` for a turn that produced no tokens or
 * was measured at zero milliseconds, and both stay unreported here: a rate
 * derived from a zero is a number that looks measured and is not.
 */
export function formatRate(
  usage: Usage,
  elapsedMs: number | undefined,
): string | undefined {
  if (elapsedMs === undefined) return undefined;
  const rate = tokensPerSecond(usage, elapsedMs);
  return rate === undefined ? undefined : `${rate.toFixed(1)} tok/s`;
}

export function formatUsage(usage: Usage): string {
  const parts = [
    `${formatCount(usage.promptTokens)} in`,
    `${formatCount(usage.completionTokens)} out`,
  ];
  if (usage.cachedTokens !== undefined && usage.cachedTokens > 0) {
    parts.push(`${formatCount(usage.cachedTokens)} cached`);
  }
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
    parts.push(`${formatCount(usage.reasoningTokens)} reasoning`);
  }
  return parts.join(' / ');
}

/**
 * Why a turn stopped, for a human.
 *
 * `complete` is absent on purpose: the answer is already on screen, and
 * announcing that it finished normally is noise on every single turn.
 */
const STOP_REASONS: Partial<Record<string, CliKey>> = {
  max_iterations: 'render.stopReasons.max_iterations',
  wall_timeout: 'render.stopReasons.wall_timeout',
  aborted: 'render.stopReasons.aborted',
  error: 'render.stopReasons.error',
};

/**
 * `riskColor` stays here rather than moving to `@ghostai/tui` with the rest of
 * the palette: it takes a `ToolRisk`, and a package whose whole claim is that it
 * has never heard of an agent cannot be the one that knows `exec` is red.
 */
function riskColor(colors: Palette, risk: ToolRisk): (text: string) => string {
  switch (risk) {
    case 'exec':
      return colors.red;
    case 'network':
      return colors.magenta;
    case 'write':
      return colors.yellow;
    default:
      return colors.cyan;
  }
}

export class TurnRenderer {
  private readonly out: RenderTarget;
  private readonly c: Palette;
  /**
   * Both are settable, because `/reasoning` and `/usage` turn them off part way
   * through a session. The flags that set them at launch — `--no-reasoning`,
   * and `--json`, which suppresses the lot — are the same two fields; a REPL
   * simply gets to change its mind.
   */
  private showReasoning: boolean;
  private showUsage: boolean;
  private readonly toolResultLines: number;
  private readonly t: CliT;
  /**
   * Tool name by call, so a result can label itself without re-reading.
   *
   * Keyed by `session:call` rather than by the call id alone. A call id is the
   * model's and is only unique within one assistant message, so a subagent can
   * mint the same one its caller just used — and a shared map would then have
   * the child's result deleting the parent's label.
   */
  private readonly calls = new Map<string, string>();

  private atLineStart = true;
  private mode: 'idle' | 'assistant' | 'reasoning' = 'idle';
  /** The session the current top-level turn is on. Set by `turn.start`. */
  private sessionKey = '';
  /**
   * How far in to write. `0` for the operator's own turn.
   *
   * Indentation is the only hierarchy signal a terminal has, and this file
   * already used it for tool results — so a subagent is two more spaces rather
   * than a new idea. Applied in `#write`, which is the one place text reaches
   * the stream, so streamed prose is indented on every line it wraps onto and
   * not only where a `#line` call happens to be.
   */
  private depth = 0;

  constructor(options: TurnRendererOptions) {
    this.out = options.out;
    this.c = pc.createColors(options.colors);
    this.showReasoning = options.showReasoning ?? true;
    this.showUsage = options.showUsage ?? true;
    this.t = options.t ?? translations(DEFAULT_LOCALE).t;
    this.toolResultLines = options.toolResultLines ?? DEFAULT_TOOL_RESULT_LINES;
  }

  handle(event: AgentEvent): void {
    if (event.type === 'subagent.event') {
      this.subagent(event);
      return;
    }
    this.render(event, this.sessionKey);
  }

  /**
   * One event, at the depth already set, attributed to `sessionKey`.
   *
   * Split from `handle` so a subagent's events go through exactly the same
   * rendering as its caller's — a nested `exec` looks like an `exec`, which is
   * the whole point of indentation being the only difference.
   */
  private render(event: NestedAgentEvent, sessionKey: string): void {
    switch (event.type) {
      case 'turn.start':
        this.mode = 'idle';
        // Only the operator's own turn resets the map. A subagent's `turn.start`
        // arriving here would otherwise drop the labels of the calls its caller
        // has in flight — including the delegating call itself.
        if (this.depth === 0) {
          this.sessionKey = event.sessionKey;
          this.calls.clear();
        }
        return;
      case 'assistant.delta':
        this.stream('assistant', event.text);
        return;
      case 'reasoning.delta':
        if (this.showReasoning) this.stream('reasoning', event.text);
        return;
      case 'tool.call':
        this.toolCall(
          sessionKey,
          event.callId,
          event.name,
          event.args,
          event.risk,
        );
        return;
      case 'tool.progress':
        this.line(
          this.c.dim(
            `  … ${this.calls.get(callKey(sessionKey, event.callId)) ?? 'tool'} ${formatDuration(event.elapsedMs)}`,
          ),
        );
        return;
      case 'tool.result':
        this.toolResult(
          sessionKey,
          event.callId,
          event.ok,
          event.content,
          event.truncated,
          event.durationMs,
        );
        return;
      case 'tool.approvalRequest':
        // The terminal has no way to answer one — `ghost chat` installs no gate,
        // so an `ask` tool simply runs. Reaching here means the CLI is watching
        // a turn some other surface is driving, and saying so beats a gap.
        this.line(
          this.c.yellow(
            `⧗ ${this.t('render.awaitingApproval', { tool: event.name })}`,
          ),
        );
        return;
      case 'notice':
        this.line(`${this.c.yellow('⚠')} ${this.c.yellow(event.message)}`);
        return;
      case 'error':
        this.error(event.code, event.message, event.retryable);
        return;
      case 'turn.end':
        this.turnEnd(
          event.stopReason,
          event.iterations,
          event.usage,
          event.elapsedMs,
        );
        return;
    }
  }

  /**
   * A subagent's event, indented under the call that started it.
   *
   * The two ends of the delegated turn get a rule of their own, at the *parent's*
   * depth, because they are the boundary rather than something inside it — the
   * same shape `#stream` uses for a mode change. Everything between
   * renders one level in, through the same `#render` the caller's events use.
   *
   * `#depth` is restored in a `finally` so a renderer is never left indented by
   * an event that threw halfway through — the next answer would otherwise be
   * written two spaces in with nothing to explain it.
   */
  private subagent(event: SubagentEvent): void {
    const who = event.label === '' ? event.agentId : event.label;
    const previous = this.depth;

    if (event.event.type === 'turn.start') {
      this.break();
      this.mode = 'idle';
      this.depth = event.depth - 1;
      try {
        this.line(
          this.c.dim(`┄ ${this.t('render.subagent.start', { agent: who })}`),
        );
      } finally {
        this.depth = previous;
      }
      return;
    }

    this.depth = event.depth;
    try {
      this.render(event.event, event.sessionKey);
    } finally {
      this.depth = previous;
    }

    if (event.event.type !== 'turn.end') return;

    this.depth = event.depth - 1;
    try {
      this.line(
        this.c.dim(`┄ ${this.t('render.subagent.done', { agent: who })}`),
      );
    } finally {
      this.depth = previous;
    }
  }

  /** Ends the turn's last line, so a prompt is never printed onto it. */
  finish(): void {
    this.break();
    this.mode = 'idle';
  }

  /** A line of the CLI's own, in the same line discipline as the events. */
  note(text: string): void {
    this.line(this.c.dim(text));
  }

  /**
   * The operator's own message, printed into the transcript.
   *
   * readline echoes what was typed, but the whole prompt block is taken down
   * when a turn starts — the rule above the editor would otherwise be left
   * behind by every turn — so the message is reprinted here. It is not an
   * `AgentEvent` and deliberately does not go through the switch: nothing on
   * the wire says "a human pressed Return in a terminal", and inventing an
   * event so that one renderer could draw a caret would be putting a CLI
   * concern into a union three transports share.
   */
  echo(text: string): void {
    this.line(`${this.c.dim('›')} ${text}`);
  }

  warn(text: string): void {
    this.line(`${this.c.yellow('⚠')} ${text}`);
  }

  /** Whether the model's reasoning is streamed. */
  get reasoningShown(): boolean {
    return this.showReasoning;
  }

  setReasoningShown(shown: boolean): void {
    this.showReasoning = shown;
  }

  /** Whether the token and timing line is printed after a turn. */
  get usageShown(): boolean {
    return this.showUsage;
  }

  setUsageShown(shown: boolean): void {
    this.showUsage = shown;
  }

  /**
   * Assistant text and reasoning, told apart by the break between them.
   *
   * Reasoning carried a `┄ thinking` header, on the argument that dimmed prose
   * is indistinguishable from the answer on a terminal that renders dim as
   * plain. In practice it read as a label on something that does not need one:
   * the reasoning arrives before the answer, ends at a line break, and is the
   * only dim run in a turn. A row of chrome on every one of them was the more
   * expensive half of that trade.
   */
  private stream(mode: 'assistant' | 'reasoning', text: string): void {
    if (this.mode !== mode) {
      this.break();
      this.mode = mode;
    }
    this.write(mode === 'reasoning' ? this.c.dim(text) : text);
  }

  private toolCall(
    sessionKey: string,
    callId: string,
    name: string,
    args: unknown,
    risk: ToolRisk,
  ): void {
    this.calls.set(callKey(sessionKey, callId), name);
    const color = riskColor(this.c, risk);
    const summary = summariseArgs(args);
    this.line(
      `${color('⚙')} ${color(name)}${summary === '' ? '' : ` ${this.c.dim(summary)}`}`,
    );
  }

  private toolResult(
    sessionKey: string,
    callId: string,
    ok: boolean,
    content: string,
    truncated: boolean,
    durationMs: number,
  ): void {
    const mark = ok ? this.c.green('✓') : this.c.red('✗');
    const suffix = truncated ? ', truncated' : '';
    this.line(
      `  ${mark} ${this.c.dim(`${formatDuration(durationMs)}${suffix}`)}`,
    );
    this.calls.delete(callKey(sessionKey, callId));

    if (this.toolResultLines <= 0 || content === '') return;
    const lines = content.split('\n');
    for (const line of lines.slice(0, this.toolResultLines)) {
      this.line(this.c.dim(`    ${clip(line, 100)}`));
    }
    const hidden = lines.length - this.toolResultLines;
    if (hidden > 0) {
      this.line(this.c.dim(`    … ${String(hidden)} more lines`));
    }
  }

  private error(code: string, message: string, retryable: boolean): void {
    this.line(`${this.c.red('✖')} ${message}`);
    this.line(this.c.dim(`  ${code}${retryable ? ' · retryable' : ''}`));
  }

  private turnEnd(
    stopReason: string,
    iterations: number,
    usage: Usage | undefined,
    elapsedMs: number | undefined,
  ): void {
    this.break();
    this.mode = 'idle';

    // `complete` is deliberately absent from the map, so an unlisted reason
    // stays `undefined` and prints nothing rather than resolving a missing key.
    const reasonKey = STOP_REASONS[stopReason];
    if (reasonKey !== undefined) {
      this.line(this.c.yellow(`  ${this.t(reasonKey)}`));
    }
    if (!this.showUsage) return;

    const parts = [this.t('render.steps', { count: iterations })];
    if (usage !== undefined && usage.totalTokens > 0) {
      parts.push(formatUsage(usage));
    }
    if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
    const rate = usage === undefined ? undefined : formatRate(usage, elapsedMs);
    if (rate !== undefined) parts.push(rate);
    this.line(this.c.dim(`  · ${parts.join(' · ')}`));
  }

  /**
   * What past turns cost, one line each.
   *
   * Through the renderer rather than written straight to the stream, like every
   * other output: this object owns `#atLineStart`, and a command that wrote
   * around it would put the next prompt on the end of a line.
   */
  stats(rows: readonly TurnStatsRecord[]): void {
    for (const row of rows) {
      const elapsedMs = Math.max(0, row.endedAtMs - row.startedAtMs);
      const parts = [
        row.model === '' ? 'unknown model' : row.model,
        this.t('render.steps', { count: row.iterations }),
        formatUsage(row.usage),
        formatDuration(elapsedMs),
      ];
      const rate = formatRate(row.usage, elapsedMs);
      if (rate !== undefined) parts.push(rate);
      this.line(this.c.dim(`  · ${parts.join(' · ')}`));
    }
  }

  private line(text: string): void {
    this.break();
    this.write(`${text}\n`);
  }

  /** A newline only when the cursor is not already at the start of one. */
  private break(): void {
    if (!this.atLineStart) this.write('\n');
  }

  /**
   * The one place text reaches the stream, and therefore the one place indent
   * belongs.
   *
   * Indenting in `#line` would be simpler and wrong: assistant text arrives as
   * arbitrary chunks through `#stream`, so a subagent's answer would be indented
   * on whichever line a chunk happened to start and flush left on every line it
   * wrapped onto. Rewriting newlines here catches both.
   */
  private write(text: string): void {
    if (text === '') return;
    const indent = '  '.repeat(this.depth);
    this.out.write(
      indent === '' ? text : indented(text, indent, this.atLineStart),
    );
    this.atLineStart = text.endsWith('\n');
  }
}

/** Unique per call across nesting. See `TurnRenderer#calls`. */
function callKey(sessionKey: string, callId: string): string {
  return `${sessionKey}:${callId}`;
}

/**
 * `text` with `indent` at the start of every line it writes.
 *
 * `atLineStart` decides whether the *first* line gets one — a chunk landing
 * mid-sentence must not be pushed across. A trailing newline is left bare, so an
 * indent is never written onto a line nothing has been put on yet: it would
 * become trailing whitespace the moment the next chunk is a `\n` of its own.
 */
function indented(text: string, indent: string, atLineStart: boolean): string {
  const body = text.replaceAll('\n', `\n${indent}`);
  const trimmed = body.endsWith(`\n${indent}`)
    ? body.slice(0, -indent.length)
    : body;
  return atLineStart ? `${indent}${trimmed}` : trimmed;
}
