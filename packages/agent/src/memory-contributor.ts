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
  readMemories,
  silentLogger,
  type Logger,
  type Memory,
} from '@ghostai/core';
import {
  DEFAULT_MEMORY_TEMPLATE,
  renderPromptTemplate,
} from '@ghostai/protocol';

import {
  templateOr,
  type ContextContributor,
  type StaticPromptContext,
} from './prompt.js';

export interface MemorySectionOptions {
  /**
   * `agents.list.<id>.memoryPrompt`. Empty means `DEFAULT_MEMORY_TEMPLATE`.
   *
   * A single space renders nothing, which is how an operator deletes the section
   * — the same contract the six section templates keep. See `docs/prompts.md`.
   */
  readonly template?: string;
}

/**
 * The section text for a set of memories.
 *
 * Pure, and separate from the contributor for the reason `renderSkills` is: the
 * ordering and what an empty folder renders as are the parts worth testing, and
 * neither needs a filesystem.
 *
 * An empty folder renders as `''`, never as a bare heading — `contributorSections`
 * drops a section that trims to nothing, so this is how "no memory" becomes "no
 * section".
 *
 * **There is no token budget, and `MAX_MEMORIES` is the only bound.** There used
 * to be a `memoryMaxPromptTokens` that cut the index short and appended a note
 * saying how many were missing. It went because the two numbers were never
 * independent: an index line is roughly fifteen tokens, so the default budget
 * afforded well over a hundred lines and the 200-file cap always arrived first.
 * A knob whose value never binds reads as a lever and is not one.
 *
 * It also carried a second job it should not have: `0` was how an operator kept
 * memory on disk and out of the prompt. That is a capability question, and it is
 * answered where the other one is — the `memory` tool's permission, which
 * `runtime.ts` gates this whole contributor on.
 */
export function renderMemorySection(
  memories: readonly Memory[],
  options: MemorySectionOptions = {},
): string {
  // Before the template is resolved, not after: an empty folder rendered
  // through the built-in would place a paragraph explaining an index that is
  // not there.
  if (memories.length === 0) return '';

  // The one statement of "empty inherits, whitespace deletes", shared with the
  // six section templates rather than spelled a seventh time.
  const template = templateOr(options.template, DEFAULT_MEMORY_TEMPLATE);
  if (template.trim() === '') return '';

  return renderPromptTemplate(template, {
    path: MEMORY_DIRNAME,
    index: memories.map(indexLine).join('\n'),
    count: String(memories.length),
  }).trim();
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

export interface MemoryContributorOptions extends MemorySectionOptions {
  readonly logger?: Logger;
}

/** Reads the workspace's memories and indexes them in the static prompt. */
export class MemoryContributor implements ContextContributor {
  readonly name: string = 'memory';

  private readonly template: string;
  private readonly logger: Logger;

  constructor(options: MemoryContributorOptions = {}) {
    this.template = options.template ?? '';
    this.logger = options.logger ?? silentLogger;
  }

  async staticSection(
    context: StaticPromptContext,
  ): Promise<string | undefined> {
    const memories = await readMemories(context.workspaceRoot, {
      logger: this.logger,
    });
    if (memories.length === 0) return undefined;

    const section = renderMemorySection(memories, {
      template: this.template,
    });
    return section === '' ? undefined : section;
  }
}
