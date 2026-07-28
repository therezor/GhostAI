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

import type { AgentEvent } from '@ghostai/agent';
import type { TurnStatsRecord } from '@ghostai/core';
import { tokensPerSecond, type ToolRisk, type Usage } from '@ghostai/protocol';
import pc from 'picocolors';

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
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
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
  return clip(entries.map(([key, value]) => `${key}=${formatValue(value)}`).join(' '), max);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${String(minutes)}m ${String(seconds).padStart(2, '0')}s`;
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
export function formatRate(usage: Usage, elapsedMs: number | undefined): string | undefined {
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
const STOP_REASONS: Partial<Record<string, string>> = {
  max_iterations: 'stopped at the tool-iteration cap',
  wall_timeout: 'stopped at the turn time cap',
  aborted: 'interrupted',
  error: 'failed',
};

type Palette = ReturnType<typeof pc.createColors>;

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
  readonly #out: RenderTarget;
  readonly #c: Palette;
  readonly #showReasoning: boolean;
  readonly #showUsage: boolean;
  readonly #toolResultLines: number;
  /** Call id → tool name, so a result can label itself without re-reading. */
  readonly #calls = new Map<string, string>();

  #atLineStart = true;
  #mode: 'idle' | 'assistant' | 'reasoning' = 'idle';

  constructor(options: TurnRendererOptions) {
    this.#out = options.out;
    this.#c = pc.createColors(options.colors);
    this.#showReasoning = options.showReasoning ?? true;
    this.#showUsage = options.showUsage ?? true;
    this.#toolResultLines = options.toolResultLines ?? DEFAULT_TOOL_RESULT_LINES;
  }

  handle(event: AgentEvent): void {
    switch (event.type) {
      case 'turn.start':
        this.#mode = 'idle';
        this.#calls.clear();
        return;
      case 'assistant.delta':
        this.#stream('assistant', event.text);
        return;
      case 'reasoning.delta':
        if (this.#showReasoning) this.#stream('reasoning', event.text);
        return;
      case 'tool.call':
        this.#toolCall(event.callId, event.name, event.args, event.risk);
        return;
      case 'tool.progress':
        this.#line(
          this.#c.dim(
            `  … ${this.#calls.get(event.callId) ?? 'tool'} ${formatDuration(event.elapsedMs)}`,
          ),
        );
        return;
      case 'tool.result':
        this.#toolResult(event.callId, event.ok, event.content, event.truncated, event.durationMs);
        return;
      case 'notice':
        this.#line(`${this.#c.yellow('⚠')} ${this.#c.yellow(event.message)}`);
        return;
      case 'error':
        this.#error(event.code, event.message, event.retryable);
        return;
      case 'turn.end':
        this.#turnEnd(event.stopReason, event.iterations, event.usage, event.elapsedMs);
        return;
    }
  }

  /** Ends the turn's last line, so a prompt is never printed onto it. */
  finish(): void {
    this.#break();
    this.#mode = 'idle';
  }

  /** A line of the CLI's own, in the same line discipline as the events. */
  note(text: string): void {
    this.#line(this.#c.dim(text));
  }

  warn(text: string): void {
    this.#line(`${this.#c.yellow('⚠')} ${text}`);
  }

  #stream(mode: 'assistant' | 'reasoning', text: string): void {
    if (this.#mode !== mode) {
      this.#break();
      // A header, because dimmed prose is otherwise indistinguishable from the
      // answer to anyone whose terminal renders dim as plain.
      if (mode === 'reasoning') this.#line(this.#c.dim('┄ thinking'));
      this.#mode = mode;
    }
    this.#write(mode === 'reasoning' ? this.#c.dim(text) : text);
  }

  #toolCall(callId: string, name: string, args: unknown, risk: ToolRisk): void {
    this.#calls.set(callId, name);
    const color = riskColor(this.#c, risk);
    const summary = summariseArgs(args);
    this.#line(`${color('⚙')} ${color(name)}${summary === '' ? '' : ` ${this.#c.dim(summary)}`}`);
  }

  #toolResult(
    callId: string,
    ok: boolean,
    content: string,
    truncated: boolean,
    durationMs: number,
  ): void {
    const mark = ok ? this.#c.green('✓') : this.#c.red('✗');
    const suffix = truncated ? ', truncated' : '';
    this.#line(`  ${mark} ${this.#c.dim(`${formatDuration(durationMs)}${suffix}`)}`);

    if (this.#toolResultLines <= 0 || content === '') return;
    const lines = content.split('\n');
    for (const line of lines.slice(0, this.#toolResultLines)) {
      this.#line(this.#c.dim(`    ${clip(line, 100)}`));
    }
    const hidden = lines.length - this.#toolResultLines;
    if (hidden > 0) this.#line(this.#c.dim(`    … ${String(hidden)} more lines`));
    this.#calls.delete(callId);
  }

  #error(code: string, message: string, retryable: boolean): void {
    this.#line(`${this.#c.red('✖')} ${message}`);
    this.#line(this.#c.dim(`  ${code}${retryable ? ' · retryable' : ''}`));
  }

  #turnEnd(
    stopReason: string,
    iterations: number,
    usage: Usage | undefined,
    elapsedMs: number | undefined,
  ): void {
    this.#break();
    this.#mode = 'idle';

    const reason = STOP_REASONS[stopReason];
    if (reason !== undefined) this.#line(this.#c.yellow(`  ${reason}`));
    if (!this.#showUsage) return;

    const parts = [`${String(iterations)} ${iterations === 1 ? 'step' : 'steps'}`];
    if (usage !== undefined && usage.totalTokens > 0) parts.push(formatUsage(usage));
    if (elapsedMs !== undefined) parts.push(formatDuration(elapsedMs));
    const rate = usage === undefined ? undefined : formatRate(usage, elapsedMs);
    if (rate !== undefined) parts.push(rate);
    this.#line(this.#c.dim(`  · ${parts.join(' · ')}`));
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
        `${String(row.iterations)} ${row.iterations === 1 ? 'step' : 'steps'}`,
        formatUsage(row.usage),
        formatDuration(elapsedMs),
      ];
      const rate = formatRate(row.usage, elapsedMs);
      if (rate !== undefined) parts.push(rate);
      this.#line(this.#c.dim(`  · ${parts.join(' · ')}`));
    }
  }

  #line(text: string): void {
    this.#break();
    this.#write(`${text}\n`);
  }

  /** A newline only when the cursor is not already at the start of one. */
  #break(): void {
    if (!this.#atLineStart) this.#write('\n');
  }

  #write(text: string): void {
    if (text === '') return;
    this.#out.write(text);
    this.#atLineStart = text.endsWith('\n');
  }
}
