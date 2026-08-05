/**
 * Memory, as a section of the prompt.
 *
 * **An index, not the contents.** One line per memory — the file to open, its
 * name, and what it is about — and the model opens the one it wants with
 * `read_file`. That is the same shape `skills-contributor.ts` uses, and it is a
 * reversal of what this file used to do: memory was one `memory.md` inlined
 * whole on every request, on the argument that memory a model has to decide to
 * go and read is memory it will forget to consult.
 *
 * The argument was not wrong, it was priced for a different object. A single
 * summary is worth inlining. A *store* — one file per fact, growing for as long
 * as the workspace does — is not: inlining it re-sends everything ever learned
 * on every request of every turn, and the only lever is a token cap that decides
 * what to forget by age rather than by relevance. An index costs a line each and
 * puts the choice where the question is.
 *
 * ## Which half it lands in
 *
 * `staticSection` only. Memory is a property of the *workspace*, so it belongs
 * in the provider's cached prefix, read once per turn. There is no
 * `runtimeSection` and no `@memory:` mention: `ParsedMentions` carries `kb`,
 * `mcp` and `skill`, and nothing about memory is a property of one message.
 *
 * It is placed *after* skills in the contributor list, and that ordering is a
 * decision rather than an accident. Sections are appended in order so the cached
 * prefix grows at the end; memory is the section most likely to change between
 * turns, so it sits where a change invalidates the least.
 *
 * ## Nothing is cached on the instance
 *
 * One `AgentLoop` serves every session on an agent, and those sessions can be
 * bound to different workspaces. A contributor that remembered what it read last
 * turn would hand one workspace's memory to a concurrent turn in another. So
 * `staticSection` re-reads — a directory of small files, once per turn.
 */

import {
  MEMORY_DIRNAME,
  MEMORY_INDEX_PATH,
  readMemories,
  silentLogger,
  type Logger,
  type Memory,
} from '@ghostai/core';
import {
  DEFAULT_MEMORY_TEMPLATE,
  renderPromptTemplate,
} from '@ghostai/protocol';
import { estimateTokens } from '@ghostai/providers';

import {
  templateOr,
  type ContextContributor,
  type StaticPromptContext,
} from './prompt.js';

export interface MemoryBudget {
  /**
   * `memoryMaxPromptTokens`. Zero places no section at all.
   *
   * It bounds the **index**, not the section: the operator's framing around it
   * is added over the top. That is `renderSkills`' convention and it exists so
   * that rewording the template does not quietly change how many memories a
   * model is told about.
   */
  readonly maxTokens: number;
  /**
   * `agents.list.<id>.memoryPrompt`. Empty means `DEFAULT_MEMORY_TEMPLATE`.
   *
   * A single space renders nothing, which is how an operator deletes the section
   * — the same contract the five section templates keep. See `docs/prompts.md`.
   */
  readonly template?: string;
}

/**
 * The section text for a set of memories and a budget.
 *
 * Pure, and separate from the contributor for the reason `renderSkills` is: the
 * budget, the ordering and what an empty folder renders as are the parts worth
 * testing, and none of them needs a filesystem.
 *
 * An empty folder renders as `''`, never as a bare heading — `contributorSections`
 * drops a section that trims to nothing, so this is how "no memory" becomes "no
 * section".
 */
export function renderMemorySection(
  memories: readonly Memory[],
  budget: MemoryBudget,
): string {
  // Before the template is resolved, not after: an empty folder rendered
  // through the built-in would place a paragraph explaining an index that is
  // not there.
  if (budget.maxTokens <= 0 || memories.length === 0) return '';

  // The one statement of "empty inherits, whitespace deletes", shared with the
  // five section templates rather than spelled a seventh time.
  const template = templateOr(budget.template, DEFAULT_MEMORY_TEMPLATE);
  if (template.trim() === '') return '';

  const { index, shown } = fit(memories, budget.maxTokens);
  return renderPromptTemplate(template, {
    path: MEMORY_DIRNAME,
    index,
    count: String(shown),
  }).trim();
}

/**
 * As many index lines as the budget affords, oldest-alphabetical first.
 *
 * **Whole lines, and the count of what was dropped.** The section this replaced
 * cut mid-string, which was right for a blob of prose and wrong for an index: an
 * index line missing its second half names a file the model cannot open, which
 * is worse than a memory it was never told about. Saying how many are missing
 * costs one line and is the difference between a model that knows to look and
 * one that concludes it has seen everything.
 */
function fit(
  memories: readonly Memory[],
  maxTokens: number,
): { readonly index: string; readonly shown: number } {
  const lines = memories.map(indexLine);

  const whole = lines.join('\n');
  if (estimateTokens(whole) <= maxTokens) {
    return { index: whole, shown: lines.length };
  }

  const kept: string[] = [];
  let tokens = 0;
  for (const line of lines) {
    // The note costs tokens too, and it is only written when something is
    // dropped — which, once we are in this branch, is certain.
    const next = tokens + estimateTokens(`${line}\n`);
    if (next > maxTokens) break;
    kept.push(line);
    tokens = next;
  }

  const dropped = lines.length - kept.length;
  return {
    index: [...kept, note(dropped)].join('\n'),
    shown: kept.length,
  };
}

/**
 * The path first, because that is the string handed back to `read_file`.
 *
 * `renderIndex` in `@ghostai/core` writes the same memories as relative markdown
 * links, and the two are deliberately different: `MEMORY.md` sits inside
 * `memory/` and is read by a person, while this is read by a model that has to
 * pass the path to a tool. A prefix it reconstructs is one it can reconstruct
 * wrongly.
 *
 * The name is not repeated beside the path, because the path already ends in it.
 * The *kind* is, at two tokens a line, because a stated preference and a pointer
 * to a document are not the same claim and the description alone does not always
 * say which one this is.
 */
function indexLine(memory: Memory): string {
  return `- \`${memory.path}\` (${memory.type}) — ${memory.description}`;
}

function note(dropped: number): string {
  return `[${String(dropped)} more not shown — the whole list is in \`${MEMORY_INDEX_PATH}\`.]`;
}

export interface MemoryContributorOptions extends MemoryBudget {
  readonly logger?: Logger;
}

/** Reads the workspace's memories and indexes them in the static prompt. */
export class MemoryContributor implements ContextContributor {
  readonly name: string = 'memory';

  private readonly maxTokens: number;
  private readonly template: string;
  private readonly logger: Logger;

  constructor(options: MemoryContributorOptions) {
    this.maxTokens = options.maxTokens;
    this.template = options.template ?? '';
    this.logger = options.logger ?? silentLogger;
  }

  async staticSection(
    context: StaticPromptContext,
  ): Promise<string | undefined> {
    // Checked before the read: a budget of zero means the section is not placed,
    // and scanning a directory to then discard it is work with no output.
    if (this.maxTokens <= 0) return undefined;

    const memories = await readMemories(context.workspaceRoot, {
      logger: this.logger,
    });
    if (memories.length === 0) return undefined;

    const section = renderMemorySection(memories, {
      maxTokens: this.maxTokens,
      template: this.template,
    });
    return section === '' ? undefined : section;
  }
}
