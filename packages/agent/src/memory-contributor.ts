/**
 * Memory, as a section of the prompt.
 *
 * The whole file, inlined. There is no index and no "open it when relevant"
 * half, which is the opposite of what `skills-contributor.ts` does, and the
 * difference is worth stating: a workspace has many skills and needs at most one
 * of them per turn, so an index earns its keep. It has exactly one memory, and
 * memory that the model has to decide to go and read is memory it will forget to
 * consult. Inlining it is also what makes the `memory` tool an append rather
 * than a read-modify-write — the current bytes are already in front of the model
 * when it decides to add to them.
 *
 * ## Which half it lands in
 *
 * `staticSection` only. Memory is a property of the *workspace*, so it belongs
 * in the provider's cached prefix, read once per turn. There is no
 * `runtimeSection` and no `@memory:` mention: `ParsedMentions` carries `kb`,
 * `mcp` and `skill` and nothing about memory is a property of one message.
 *
 * It is placed *after* skills in the contributor list, and that ordering is a
 * decision rather than an accident. Sections are appended in order so the cached
 * prefix grows at the end; memory is the section most likely to change between
 * turns, so it sits where a change invalidates the least.
 *
 * ## Nothing is cached on the instance
 *
 * One `AgentLoop` serves every session on an agent, and those sessions can be
 * bound to different workspaces. A contributor that remembered the file it read
 * last turn would hand one workspace's memory to a concurrent turn in another.
 * So `staticSection` re-reads — one small file, once per turn.
 */

import {
  MEMORY_PATH,
  readMemory,
  silentLogger,
  type Logger,
} from '@ghostai/core';
import { estimateTokens } from '@ghostai/providers';

import type { ContextContributor, StaticPromptContext } from './prompt.js';

const HEADING = '## Memory';

/**
 * Placed only when there is something to explain.
 *
 * It names the tool because a block of facts with no instruction to add to it is
 * read as background, not as somewhere to write.
 */
const PREAMBLE = [
  `What you have learned about this workspace, kept in \`${MEMORY_PATH}\`.`,
  'To record something durable, call the `memory` tool — it appends, so',
  'nothing here is lost. Keep entries short: this file is in every prompt on',
  'this folder.',
].join(' ');

const TRUNCATION_NOTE = `[Truncated — read ${MEMORY_PATH} for the rest.]`;

export interface MemoryBudget {
  /**
   * `memoryMaxPromptTokens`. Zero places no section at all.
   *
   * The schema already allows zero, and it is the natural reading of an empty
   * budget — so it doubles as a way to keep memory on disk while keeping it out
   * of the prompt, with no second key to express that.
   *
   * It bounds the **memory**, not the section: the heading and the preamble are
   * added over it. That is `truncateHeadTail`'s convention, and it exists so
   * that rewording the framing does not quietly change how much of a user's
   * memory survives.
   */
  readonly maxTokens: number;
}

/**
 * The section text for a memory and a budget.
 *
 * Pure, and separate from the contributor for the reason `renderSkills` is: the
 * budget, the truncation and what an empty memory renders as are the parts worth
 * testing, and none of them needs a filesystem.
 *
 * An empty memory renders as `''`, never as a bare heading — `contributorSections`
 * drops a section that trims to nothing, so this is how "no memory" becomes "no
 * section".
 */
export function renderMemory(text: string, budget: MemoryBudget): string {
  if (budget.maxTokens <= 0) return '';

  const trimmed = text.trim();
  if (trimmed === '') return '';

  return [HEADING, PREAMBLE, fit(trimmed, budget.maxTokens)].join('\n\n');
}

/**
 * Keeps the newest text, drops the oldest.
 *
 * The opposite of `truncateHeadTail`, and deliberately: a memory file is written
 * newest-last, so the tail is what a recent session learned and the head is what
 * compaction has already summarised once. Cutting the head loses the least.
 *
 * `estimateTokens` is `ceil(length / 4)`, which is what makes the character
 * bound below exact rather than a converging loop.
 */
function fit(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;

  const maxChars = maxTokens * 4 - TRUNCATION_NOTE.length - 2;
  if (maxChars <= 0) return TRUNCATION_NOTE;

  // From a line boundary, so the section the model reads first is a whole one.
  const tail = text.slice(-maxChars);
  const newline = tail.indexOf('\n');
  return `${TRUNCATION_NOTE}\n${newline === -1 ? tail : tail.slice(newline + 1)}`;
}

export interface MemoryContributorOptions extends MemoryBudget {
  readonly logger?: Logger;
}

/** Reads the workspace's memory and places it in the static prompt. */
export class MemoryContributor implements ContextContributor {
  readonly name: string = 'memory';

  private readonly maxTokens: number;
  private readonly logger: Logger;

  constructor(options: MemoryContributorOptions) {
    this.maxTokens = options.maxTokens;
    this.logger = options.logger ?? silentLogger;
  }

  async staticSection(
    context: StaticPromptContext,
  ): Promise<string | undefined> {
    // Checked before the read: a budget of zero means the section is not placed,
    // and reading a file to then discard it is work with no output.
    if (this.maxTokens <= 0) return undefined;

    const text = await readMemory(context.workspaceRoot, {
      logger: this.logger,
    });
    if (text === undefined) return undefined;

    const section = renderMemory(text, { maxTokens: this.maxTokens });
    return section === '' ? undefined : section;
  }
}
