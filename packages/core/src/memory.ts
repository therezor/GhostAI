/**
 * Memory: what an agent has learned about a workspace, kept in `memory/`.
 *
 * **One file per fact**, named by a slug, with frontmatter saying what it is
 * about — and one generated `MEMORY.md` indexing them:
 *
 * ```
 * <workspace>/memory/
 * ├── MEMORY.md
 * ├── run-full-ci-gate.md
 * └── ui-stack-preferences.md
 * ```
 *
 * ```markdown
 * ---
 * name: ui-stack-preferences
 * description: no shadcn/ui; Tailwind in rem, not px
 * metadata:
 *   type: user
 * ---
 *
 * The user wants an explicit design token layer. See [[design-token-gates]].
 * ```
 *
 * This module is the disk half and nothing else: bytes to `Memory` and back.
 * What reaches the prompt, and at what budget, is `@ghostai/agent`'s
 * `memory-contributor.ts`.
 *
 * ## Why one file per fact
 *
 * It used to be one `memory.md` with dated sections, inlined whole into every
 * prompt on the folder. That is the arrangement a *summary* wants and the wrong
 * one for a *store*: everything ever learned was re-sent on every request
 * whether or not a word of it bore on the question, and the only lever was a
 * token cap that cut the oldest lines off the front. A file per fact gives each
 * one a name to be corrected under, a description to be found by, and a body
 * that costs nothing until something opens it.
 *
 * ## Four decisions worth stating
 *
 * **The directory is the truth; `MEMORY.md` is derived.** It is regenerated on
 * every save and never read back — the prompt index comes from `readMemories`,
 * so a memory deleted by hand leaves the prompt on the next turn whatever the
 * index file still says. It exists because a folder a person opens should
 * describe itself, and being derived is what makes it unable to be wrong in a
 * way that matters.
 *
 * **The slug is the identity.** It is the filename, the `name` in the
 * frontmatter, and what a `[[link]]` in another memory refers to. Saving under a
 * name that exists *replaces* that memory, which is the whole of how a wrong one
 * is corrected rather than contradicted by a second one beside it.
 *
 * **Reading never throws.** A memory file is workspace content, which means it
 * is whatever a person or a previous turn left there. A malformed one costs that
 * memory, not every turn on the workspace — the same position
 * `@ghostai/agent`'s `skills.ts` takes on a broken skill.
 *
 * **Every write is atomic.** A temp file beside the target, then a rename, so a
 * crash midway cannot leave half a memory for the next turn to index.
 *
 * ## Where this lives, and what it costs
 *
 * In the workspace, which is inside the jail, which means `write_file` and
 * `exec` can both edit it. `paths.ts` puts an agent's own directory *beside* the
 * workspace for exactly this reason, and the tradeoff here is deliberate: memory
 * is meant to be committed beside the project it describes and readable in a
 * directory listing, and a file the agent cannot see is not that. The `memory`
 * tool is therefore the *intended* way to write these files, not an enforced
 * one. See `docs/memory.md`.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseFrontmatter } from './frontmatter.js';
import { silentLogger, type Logger } from './logger.js';

/** The folder inside the workspace that holds them. */
export const MEMORY_DIRNAME = 'memory';

/** The generated index inside it. Never read back; see the header. */
export const MEMORY_INDEX_FILENAME = 'MEMORY.md';

/**
 * Workspace-relative, POSIX.
 *
 * Built with `/` rather than `join`, because these strings are handed to the
 * model to pass back to `read_file`, which takes POSIX separators on every host.
 * A Windows `join` would produce a path the jail then has to guess at.
 */
export const MEMORY_INDEX_PATH: string = `${MEMORY_DIRNAME}/${MEMORY_INDEX_FILENAME}`;

/**
 * The most of one memory that is read at all.
 *
 * A different job from `memoryMaxPromptTokens`, and the two are not
 * interchangeable: this one stops a runaway file from reaching a Buffer, and the
 * token budget decides how many index lines a model sees.
 *
 * The same figure as `SKILL_MAX_BYTES`, and the argument transfers: this is what
 * a `read_file` on one of these costs when the model opens it. It used to be
 * 256 KB — twenty times the prompt budget — because the whole file was inlined
 * and compaction needed something oversized to compact. Nothing here reaches the
 * prompt now, and one fact does not need twelve kilobytes, let alone twenty
 * times that.
 */
export const MEMORY_MAX_BYTES: number = 12 * 1024;

/**
 * The most memories one workspace advertises.
 *
 * A bound rather than a courtesy, and the same argument `MAX_SKILLS` makes: the
 * index costs a line per memory on every request, and a folder that has
 * accumulated a thousand should meet a wall and a log line rather than a prompt
 * nobody budgeted for.
 */
export const MAX_MEMORIES = 200;

/** How much of a description an index line carries. */
export const MAX_MEMORY_DESCRIPTION_CHARS = 200;

/**
 * How `MEMORY.md` says it was generated.
 *
 * An HTML comment, so a markdown reader hides it, and the first line, so
 * recognising one costs a `startsWith`. It exists for a single case that is
 * otherwise silent data loss: on a **case-insensitive filesystem** — macOS,
 * Windows — the `memory/memory.md` an install from before this format left
 * behind *is* the path `MEMORY.md` resolves to, so the first save would replace
 * an operator's notes with a generated list. `saveMemory` refuses to write over
 * a file that does not carry this line and moves it aside instead.
 */
const INDEX_MARKER =
  '<!-- generated by ghostai — edit the memories, not this -->';

/** The longest slug a memory may be named. Comfortably a phrase. */
export const MAX_MEMORY_NAME_CHARS = 64;

/**
 * What a memory is *about*, as four kinds.
 *
 * Not a free-text tag, and it does two jobs. Writing one forces a model to
 * decide what kind of thing it has learned — a note that is none of the four is
 * usually one that belongs in the conversation rather than on disk. Reading one
 * back tells it how much weight the note carries: a stated preference and a
 * pointer to a document are not the same claim, and the index says which is
 * which so that deciding what to open is not purely a guess from the
 * description.
 */
export const MEMORY_TYPES = [
  /** Who the user is: role, expertise, standing preferences. */
  'user',
  /** How they have asked to be worked with, and why. */
  'feedback',
  /** An ongoing goal or constraint not derivable from the code. */
  'project',
  /** A pointer to something outside the workspace: a URL, a ticket. */
  'reference',
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** One fact, as it is on disk. */
export interface Memory {
  /** The slug: the filename without `.md`, and what a `[[link]]` names. */
  readonly name: string;
  /** One line, collapsed and bounded. The basis on which a model opens it. */
  readonly description: string;
  readonly type: MemoryType;
  /** Everything after the frontmatter, already bounded by `MEMORY_MAX_BYTES`. */
  readonly body: string;
  /** Workspace-relative, as the model would pass it to `read_file`. */
  readonly path: string;
}

/** A memory to save. The path is derived, so it is not asked for. */
export type MemoryInput = Omit<Memory, 'path'>;

export interface ReadMemoriesOptions {
  readonly logger?: Logger;
}

/** What `saveMemory` did, so a caller can say which. */
export interface SaveMemoryResult {
  /** The slug actually used, which may differ from the one asked for. */
  readonly name: string;
  /** Workspace-relative, POSIX. */
  readonly path: string;
  /** True when a memory of that name already existed and was replaced. */
  readonly replaced: boolean;
  /** How many memories the folder holds afterwards. */
  readonly total: number;
}

/**
 * A model-chosen name as a safe file stem, or `undefined` when nothing survives.
 *
 * **This is where the guarantee the `memory` tool used to get for free is
 * restored.** That tool's whole justification over `write_file` was that it took
 * *no path* — "there is no path for a model to get wrong and nothing for the
 * jail to adjudicate". A named memory puts a model-chosen string back into a
 * filename, so the guarantee has to be re-established somewhere, and it is here
 * rather than in the tool's schema: the result is `[a-z0-9-]` and nothing else,
 * so it cannot contain `/`, `\`, `.` or `..` and cannot leave `memory/` by
 * construction rather than by a check somebody could forget to call.
 *
 * It **slugs rather than rejects**: `UI Stack Preferences` becomes
 * `ui-stack-preferences`, which is the useful answer. Refusing would cost a
 * round trip to teach a rule that could simply have been applied — and callers
 * report the name that was actually used, so nothing is silently renamed.
 *
 * `MEMORY.md`'s stem is refused outright, because the index is generated: a
 * memory named `memory` would be replaced by the next save with no error anyone
 * could see.
 */
export function memorySlug(raw: string): string | undefined {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_MEMORY_NAME_CHARS)
    // The cap can land on a separator, and a stem ending in one is untidy in a
    // directory listing for no reason.
    .replace(/-+$/, '');

  if (slug === '' || isIndexStem(slug)) return undefined;
  return slug;
}

/**
 * One promise chain per workspace, so writers queue rather than interleave.
 *
 * **Module-level, not per-instance, and that is the point.** A save is a
 * read-modify-write of the *folder* — the memory itself, then the index
 * regenerated from everything in it — so two saves landing together would each
 * write an index that does not know about the other's file. A lock owned by an
 * instance would not be seen by a second one.
 *
 * In-process is enough: one process owns an install. Entries are dropped when
 * their chain drains, so this does not grow an entry per workspace forever.
 */
const locks = new Map<string, Promise<unknown>>();

/** Serialises work on one workspace's memory folder. */
export async function withMemoryLock<T>(
  workspaceRoot: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(workspaceRoot) ?? Promise.resolve();
  const run = previous.then(work);

  // What the *next* caller waits on, and it never rejects — otherwise one
  // failed write would reject everything queued behind it.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(workspaceRoot, tail);

  try {
    return await run;
  } finally {
    // Identity, not presence: if someone queued behind us the map already holds
    // *their* tail, and deleting it would let a third caller run alongside them.
    if (locks.get(workspaceRoot) === tail) locks.delete(workspaceRoot);
  }
}

/**
 * Every loadable memory in a workspace, sorted by name.
 *
 * Sorted because the result lands in the provider's cached prefix, and a
 * `readdir` order that varies between hosts would move that prefix for no reason
 * anyone could see.
 *
 * A workspace with no `memory/` folder is the empty array. That is the ordinary
 * case rather than a misconfiguration, so it is not logged.
 */
export async function readMemories(
  workspaceRoot: string,
  options: ReadMemoriesOptions = {},
): Promise<readonly Memory[]> {
  const logger = options.logger ?? silentLogger;
  const dir = join(workspaceRoot, MEMORY_DIRNAME);

  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name.slice(0, -'.md'.length))
      // The index is generated from these, so reading it back as one of them
      // would advertise a memory whose body is a list of the others.
      //
      // Case-insensitively, which also skips the `memory.md` an install from
      // before this format left behind: on a case-insensitive filesystem it *is*
      // `MEMORY.md`, and on a case-sensitive one it is a file with no
      // frontmatter that would otherwise warn on every turn forever.
      .filter((name) => !isIndexStem(name))
      .sort();
  } catch {
    return [];
  }

  if (names.length > MAX_MEMORIES) {
    logger.warn(
      { dir, found: names.length, max: MAX_MEMORIES },
      'more memory files than the cap; the rest are not advertised',
    );
    names = names.slice(0, MAX_MEMORIES);
  }

  const loaded = await Promise.all(
    names.map((name) => readOne(dir, name, logger)),
  );
  return loaded.filter((memory) => memory !== undefined);
}

/**
 * Creates or replaces one memory, then regenerates the index.
 *
 * Both under the lock and in that order. The index is derived from the folder,
 * so it has to be written after the file it describes — the other order
 * publishes a line pointing at something that is not there yet, and a turn
 * landing in between would advertise a memory `read_file` cannot open.
 */
export async function saveMemory(
  workspaceRoot: string,
  memory: MemoryInput,
): Promise<SaveMemoryResult> {
  // Slugged here as well as by the caller, and deliberately: this is the
  // function that turns a string into a path, so it is the one that must not be
  // able to be handed a bad one.
  const name = memorySlug(memory.name);
  if (name === undefined) {
    throw new Error(`memory name is not usable as a filename: ${memory.name}`);
  }

  const dir = join(workspaceRoot, MEMORY_DIRNAME);

  return await withMemoryLock(workspaceRoot, async () => {
    const before = await readMemories(workspaceRoot);
    const replaced = before.some((existing) => existing.name === name);

    await mkdir(dir, { recursive: true });
    await writeAtomic(
      join(dir, `${name}.md`),
      renderMemory({ ...memory, name }),
    );

    const after = await readMemories(workspaceRoot);
    const index = join(dir, MEMORY_INDEX_FILENAME);
    await preserveUngenerated(index);
    await writeAtomic(index, renderIndex(after));

    return {
      name,
      path: `${MEMORY_DIRNAME}/${name}.md`,
      replaced,
      total: after.length,
    };
  });
}

/**
 * Moves aside whatever is at the index path and was not written by us.
 *
 * The case this exists for is `memory/memory.md` on a case-insensitive
 * filesystem: it resolves to the same file as `MEMORY.md`, so writing the
 * generated index would overwrite an operator's notes from the format this one
 * replaced. Renaming to `.replaced` keeps them on disk under a name that is not
 * a memory, which is the promise `docs/memory.md` makes.
 *
 * A read failure is not fatal — a folder that cannot be read cannot be written
 * either, and the write immediately after will say so with a real error.
 */
async function preserveUngenerated(index: string): Promise<void> {
  let existing: string;
  try {
    existing = await readFile(index, 'utf8');
  } catch {
    return;
  }

  if (existing.startsWith(INDEX_MARKER)) return;
  await rename(index, `${index}.replaced`);
}

/**
 * The bytes of one memory file.
 *
 * Writes `metadata.type` nested, because that is the format — and reads back
 * flat, because `parseFrontmatter` trims before it matches. The asymmetry is
 * documented at both ends; see `frontmatter.ts`.
 */
export function renderMemory(memory: MemoryInput): string {
  return [
    '---',
    `name: ${memory.name}`,
    `description: ${collapse(memory.description)}`,
    'metadata:',
    `  type: ${memory.type}`,
    '---',
    '',
    memory.body.trim(),
    '',
  ].join('\n');
}

/**
 * The whole of `MEMORY.md`.
 *
 * Relative links, because this file sits *inside* `memory/` and is read by a
 * person with an editor or a browser open on the folder. The prompt's index is
 * rendered separately with full workspace-relative paths, since those strings go
 * straight back to `read_file` and a prefix the model has to reconstruct is one
 * it can reconstruct wrongly.
 */
export function renderIndex(memories: readonly Memory[]): string {
  const lines = memories.map(
    (memory) =>
      `- [${memory.name}](${memory.name}.md) _(${memory.type})_ — ${memory.description}`,
  );
  return [
    INDEX_MARKER,
    '',
    '# Memory',
    '',
    'One file per fact. Regenerated from this folder on every save — edit the',
    'memories, not this list.',
    '',
    ...(lines.length === 0 ? ['_Nothing recorded yet._'] : lines),
    '',
  ].join('\n');
}

async function readOne(
  dir: string,
  name: string,
  logger: Logger,
): Promise<Memory | undefined> {
  const file = join(dir, `${name}.md`);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    logger.warn({ memory: name, file }, 'memory could not be read');
    return undefined;
  }

  const { fields, body } = parseFrontmatter(truncateBytes(text));

  // The description is the entire basis on which a model decides to open the
  // file, so a memory without one cannot be advertised — an index line reading
  // "**ci-gate**: " teaches it that the memory is about nothing.
  const description = collapse(fields.description ?? '');
  if (description === '') {
    logger.warn({ memory: name, file }, 'memory has no description; skipped');
    return undefined;
  }

  // A memory whose kind is missing or misspelled is still a memory, so it is
  // kept and filed under the kind that assumes least. Refusing it would lose a
  // fact over a label — and `project` is what a hand-written note that never
  // heard of the vocabulary actually is.
  const declared = fields['metadata.type'] ?? '';
  if (declared !== '' && !isMemoryType(declared)) {
    logger.warn(
      { memory: name, file, type: declared },
      'memory has an unrecognised metadata.type; read as project',
    );
  }

  return {
    name,
    description: description.slice(0, MAX_MEMORY_DESCRIPTION_CHARS),
    type: isMemoryType(declared) ? declared : 'project',
    body,
    path: `${MEMORY_DIRNAME}/${name}.md`,
  };
}

/**
 * Writes beside the target and renames over it.
 *
 * The temp file is in the same directory deliberately: a rename across
 * filesystems is a copy, and a copy is not atomic.
 */
async function writeAtomic(target: string, text: string): Promise<void> {
  const temp = `${target}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, target);
}

function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

/** One line, whatever it arrived as. A description spanning two breaks an index. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Case-insensitively, because that is how the filesystem may see it. */
function isIndexStem(name: string): boolean {
  return (
    name.toLowerCase() ===
    MEMORY_INDEX_FILENAME.slice(0, -'.md'.length).toLowerCase()
  );
}

function truncateBytes(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MEMORY_MAX_BYTES) return text;

  // Cut the bytes, then decode: a multi-byte character split down the middle
  // becomes one replacement character rather than corrupting what follows.
  const cut = Buffer.from(text, 'utf8')
    .subarray(0, MEMORY_MAX_BYTES)
    .toString('utf8');

  // That replacement character is *three* bytes, so a cut through a two-byte
  // character decodes to something longer than the cap it was meant to enforce.
  // Dropping the tail character is the only way the bound actually holds.
  return Buffer.byteLength(cut, 'utf8') > MEMORY_MAX_BYTES
    ? cut.slice(0, -1)
    : cut;
}
