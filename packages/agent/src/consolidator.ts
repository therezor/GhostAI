/**
 * Compression, with the I/O attached.
 *
 * `consolidation.ts` decides *what* to fold; this decides when the file and the
 * marker move, and in which order. Everything interesting here is in that order
 * and in the lock around it.
 *
 * ## File first, marker second — never the reverse
 *
 * Step 7 writes `memory.md`. Step 8 advances `lastConsolidatedSeq`. A crash
 * between them replays messages the memory already summarises: the prompt says
 * the same thing twice for a while, the next compression produces a near
 * duplicate, and a person can see it and fix it by editing a file. The other
 * order moves the marker past messages nothing represents — gone from every
 * future prompt, permanently, with no code path able to notice.
 *
 * There is no cheap transaction spanning a SQLite row and a file on disk, so
 * this is a choice between two failure modes rather than an oversight.
 *
 * ## The lock
 *
 * Keyed by workspace root and shared with the `memory` tool's appends, because
 * both read-modify-write the same file. Without it, a tool call landing during a
 * compression is a lost note, and two compressions started together fold the
 * same span twice. In-process is enough: one process owns an install.
 *
 * ## It throws, unlike most of this package
 *
 * A person is waiting for the answer to `/memory compress`. A silent failure
 * that leaves history exactly as large as it was is worse than a message saying
 * what went wrong, which is the opposite of the tradeoff a background pass would
 * make.
 */

import {
  parseSections,
  readMemory,
  renderMemoryFile,
  silentLogger,
  systemClock,
  systemMessage,
  textOf,
  userMessage,
  withMemoryLock,
  writeMemory,
  type Clock,
  type Logger,
  type SessionStore,
} from '@ghostai/core';
import { estimateTokens, type ChatProvider } from '@ghostai/providers';

import {
  COMPACT_INSTRUCTION,
  CONSOLIDATE_INSTRUCTION,
  CONSOLIDATE_TO_FRACTION,
  KEEP_RECENT_TURNS,
  compactSections,
  selectSpan,
  transcript,
} from './consolidation.js';

/** What one compression did, so a command can say it out loud. */
export interface CompressionResult {
  /** Messages folded into memory. `0` means there was nothing to do. */
  readonly folded: number;
  /** Where `lastConsolidatedSeq` ended up. Unchanged when nothing was folded. */
  readonly cut: number;
  /** Whether the notes themselves were merged down as well. */
  readonly compacted: boolean;
  /** The memory file's size afterwards, in estimated tokens. */
  readonly memoryTokens: number;
}

/**
 * The port a command calls.
 *
 * Named for what it does rather than for what it is, so the CLI and the Telegram
 * console can depend on this without either learning what a provider is.
 */
export interface TurnConsolidator {
  compress(input: CompressionInput): Promise<CompressionResult>;
}

export interface CompressionInput {
  readonly sessionKey: string;
  /** Absolute and canonical — `jail.root`, captured by the caller. */
  readonly workspaceRoot: string;
}

export interface MemoryConsolidatorOptions {
  readonly store: SessionStore;
  readonly provider: ChatProvider;
  /** `consolidationModel` if set, else the agent's own. */
  readonly model: string;
  readonly contextWindowTokens: number;
  /** `memoryMaxPromptTokens`. What a compaction aims the notes down to. */
  readonly maxPromptTokens: number;
  /** `memoryCompactThresholdTokens`. Above this the notes are merged. */
  readonly compactThresholdTokens: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export class MemoryConsolidator implements TurnConsolidator {
  private readonly store: SessionStore;
  private readonly provider: ChatProvider;
  private readonly model: string;
  private readonly contextWindowTokens: number;
  private readonly maxPromptTokens: number;
  private readonly compactThresholdTokens: number;
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(options: MemoryConsolidatorOptions) {
    this.store = options.store;
    this.provider = options.provider;
    this.model = options.model;
    this.contextWindowTokens = options.contextWindowTokens;
    this.maxPromptTokens = options.maxPromptTokens;
    this.compactThresholdTokens = options.compactThresholdTokens;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
  }

  async compress(input: CompressionInput): Promise<CompressionResult> {
    // The lock is `@ghostai/core`'s, not this instance's: the `memory` tool
    // appends through the same one, so a note written mid-compression queues
    // instead of being read, discarded and lost.
    return await withMemoryLock(input.workspaceRoot, async () => {
      return await this.compressNow(input);
    });
  }

  private async compressNow(
    input: CompressionInput,
  ): Promise<CompressionResult> {
    // Re-read inside the lock: a compression that queued behind another must
    // see the marker that one advanced, or it folds the same span twice.
    const session = this.store.getSession(input.sessionKey);
    if (session === undefined) {
      return { folded: 0, cut: 0, compacted: false, memoryTokens: 0 };
    }

    const records = this.store.messages(input.sessionKey, {
      afterSeq: session.lastConsolidatedSeq,
    });

    const span = selectSpan(records, {
      keepTurns: KEEP_RECENT_TURNS,
      toTokens: Math.floor(this.contextWindowTokens * CONSOLIDATE_TO_FRACTION),
    });

    const existing = (await readMemory(input.workspaceRoot)) ?? '';
    const parsed = parseSections(existing);
    const today = new Date(this.clock.now()).toISOString().slice(0, 10);

    let sections = [...parsed.sections];

    if (span !== undefined) {
      const summary = await this.summarise(
        CONSOLIDATE_INSTRUCTION,
        transcript(span.messages),
      );
      if (summary !== '') {
        const last = sections.at(-1);
        sections =
          last?.date === today
            ? [
                ...sections.slice(0, -1),
                { date: today, body: `${last.body}\n${summary}` },
              ]
            : [...sections, { date: today, body: summary }];
      }
    }

    const notes = sections.map((section) => section.body).join('\n');
    const compacted = estimateTokens(notes) > this.compactThresholdTokens;
    if (compacted) {
      const merged = await this.summarise(COMPACT_INSTRUCTION, notes);
      sections = [...compactSections(sections, merged, today)];
    }

    const text = renderMemoryFile(parsed.preamble, sections);

    // The file, then the marker. See the header for why this order is not
    // interchangeable.
    await writeMemory(input.workspaceRoot, text);

    if (span !== undefined) {
      this.store.updateSession(input.sessionKey, {
        lastConsolidatedSeq: span.cut,
      });
    }

    return {
      folded: span?.messages.length ?? 0,
      cut: span?.cut ?? session.lastConsolidatedSeq,
      compacted,
      memoryTokens: estimateTokens(text),
    };
  }

  /** One non-streamed request. Nobody is watching this, so it emits no events. */
  private async summarise(
    instruction: string,
    content: string,
  ): Promise<string> {
    if (content.trim() === '') return '';

    const result = await this.provider.chat({
      model: this.model,
      messages: [systemMessage(instruction), userMessage(content)],
      // No tools: a summariser that could call one would be an agent loop, and
      // there is nothing here for it to act on.
      maxTokens: this.maxPromptTokens,
    });

    const text = textOf(result.message).trim();

    if (text === '') {
      this.logger.warn({ model: this.model }, 'summariser returned nothing');
    }
    return text;
  }
}
