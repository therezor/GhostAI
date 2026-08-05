/**
 * Memory: what an agent has learned about a workspace, kept in `memory/`.
 *
 * One file, `memory.md`, and it has a shape rather than being free text:
 *
 * ```markdown
 * Prose written by hand. Nothing below ever rewrites it.
 *
 * ## Session 2026-08-05
 *
 * - The user prefers rem over px.
 * ```
 *
 * Everything above the first `## Session` heading is the **preamble** and
 * belongs to whoever typed it. Everything below is a series of dated sections
 * the agent appends to. That boundary is the whole reason the format is not free
 * text: compaction rewrites sections with a model, and without somewhere to
 * stop, the first compaction would paraphrase away an operator's "always deploy
 * with `make release`".
 *
 * This module is the disk half and nothing else: bytes to text and back. What
 * reaches the prompt, and at what budget, is `memory-contributor.ts`; what
 * compaction does with the sections is `@ghostai/agent`’s `consolidation.ts`.
 *
 * ## Three decisions worth stating
 *
 * **Appending never rewrites.** `appendMemory` adds to the last section or opens
 * a new one; it cannot touch what is already there. `writeMemory` is the only
 * operation that replaces the file, it exists for compaction, and it is named
 * and documented as the exception so that a future caller has to notice.
 *
 * **Reading never throws.** `memory.md` is workspace content, which means it is
 * whatever a person or a previous turn left there. A malformed or unreadable
 * file must cost memory, not every turn on the workspace — the same position
 * `@ghostai/agent`’s `skills.ts` takes on a broken skill.
 *
 * ## Where this lives, and what it costs
 *
 * In the workspace, which is inside the jail, which means `write_file` and
 * `exec` can both edit it. `paths.ts` puts an agent's own directory *beside* the
 * workspace for exactly this reason, and the tradeoff here is deliberate: memory
 * is meant to be committed beside the project it describes and readable in a
 * directory listing, and a file the agent cannot see is not that. The `memory`
 * tool is therefore the *intended* way to write this file, not an enforced one.
 * See `docs/memory.md`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { silentLogger, type Logger } from './logger.js';

/** The folder inside the workspace that holds it. */
export const MEMORY_DIRNAME = 'memory';

/** The one file in it. */
export const MEMORY_FILENAME = 'memory.md';

/**
 * Workspace-relative, POSIX.
 *
 * Built with `/` rather than `join`, because this string is handed to the model
 * to pass back to `read_file`, which takes POSIX separators on every host. A
 * Windows `join` would produce a path the jail then has to guess at.
 */
export const MEMORY_PATH: string = `${MEMORY_DIRNAME}/${MEMORY_FILENAME}`;

/**
 * The most of the file that is read at all.
 *
 * A different job from `memoryMaxPromptTokens`, and the two are not
 * interchangeable: this one stops a runaway file from reaching a Buffer, and the
 * token budget decides what a model sees. 256 KB is roughly twenty times the
 * prompt budget, which is the point — a file well past what will be shown still
 * gets read, so compaction has something to compact.
 */
export const MEMORY_MAX_BYTES: number = 256 * 1024;

/** The heading that opens a dated section. */
const SECTION_PREFIX = '## Session ';

/** One dated block of what was learned. */
export interface MemorySection {
  /** `YYYY-MM-DD`, as it appears in the heading. */
  readonly date: string;
  /** Everything under the heading, trimmed. Never includes the heading. */
  readonly body: string;
}

/** A parsed `memory.md`. */
export interface ParsedMemory {
  /** Everything above the first heading. The operator's, never rewritten. */
  readonly preamble: string;
  readonly sections: readonly MemorySection[];
}

export interface ReadMemoryOptions {
  readonly logger?: Logger;
}

/**
 * One promise chain per workspace, so writers queue rather than interleave.
 *
 * **Module-level, not per-instance, and that is the point.** Two different
 * things write this file — the `memory` tool appending a note during a turn, and
 * compaction rewriting the whole thing — and they are constructed in different
 * places. A lock owned by either would not be seen by the other, so an append
 * landing mid-compaction would be read, discarded and silently lost.
 *
 * In-process is enough: one process owns an install. Entries are dropped when
 * their chain drains, so this does not grow an entry per workspace forever.
 */
const locks = new Map<string, Promise<unknown>>();

/**
 * Serialises work on one workspace's memory file.
 *
 * Every read-modify-write of `memory.md` goes through this. `readMemory` does
 * not — a stale read costs a turn one slightly old prompt, and taking the lock
 * on the hot path would serialise every turn behind whatever is writing.
 */
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
 * The workspace's memory, or `undefined` when it has none.
 *
 * A workspace with no `memory/memory.md` is `undefined`, and that is the
 * ordinary case rather than a misconfiguration, so it is not logged. A file that
 * exists but cannot be read *is* worth a line, because someone meant it to work.
 */
export async function readMemory(
  workspaceRoot: string,
  options: ReadMemoryOptions = {},
): Promise<string | undefined> {
  const logger = options.logger ?? silentLogger;
  const file = memoryFile(workspaceRoot);

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    logger.warn({ file }, 'memory file could not be read');
    return undefined;
  }

  return truncateBytes(text, MEMORY_MAX_BYTES);
}

/**
 * Adds a note under today's heading, opening one if the date has moved on.
 *
 * Read-modify-write rather than `O_APPEND`, because a heading is only written
 * when the date changes and that decision needs the current tail. Callers
 * serialise this against compaction; see `consolidator.ts` for the lock.
 *
 * `whenIso` is a full ISO timestamp and only its date part is used — the caller
 * already has a `Clock`, and a second time source here would be a way for the
 * two to disagree.
 */
export async function appendMemory(
  workspaceRoot: string,
  note: string,
  whenIso: string,
): Promise<void> {
  const trimmed = note.trim();
  if (trimmed === '') return;

  const date = whenIso.slice(0, 10);

  await withMemoryLock(workspaceRoot, async () => {
    const existing = (await readMemory(workspaceRoot)) ?? '';
    const { preamble, sections } = parseSections(existing);

    const last = sections.at(-1);
    const next =
      last?.date === date
        ? [...sections.slice(0, -1), { date, body: `${last.body}\n${trimmed}` }]
        : [...sections, { date, body: trimmed }];

    await writeMemory(workspaceRoot, renderMemoryFile(preamble, next));
  });
}

/**
 * Replaces the whole file.
 *
 * **The only operation that rewrites what is already there**, and it exists for
 * compaction. Everything else appends. Kept exported rather than hidden because
 * `consolidation.ts` is the caller, but a new call site is a decision worth
 * noticing rather than a convenience.
 *
 * Writes a temp file beside the target and renames over it, so a crash midway
 * cannot leave a half-written memory that the next turn inlines. The temp file
 * is in the same directory deliberately: a rename across filesystems is a copy,
 * and a copy is not atomic.
 */
export async function writeMemory(
  workspaceRoot: string,
  text: string,
): Promise<void> {
  const dir = join(workspaceRoot, MEMORY_DIRNAME);
  await mkdir(dir, { recursive: true });

  const target = join(dir, MEMORY_FILENAME);
  const temp = `${target}.tmp`;
  await writeFile(temp, text, 'utf8');
  await rename(temp, target);
}

/**
 * Splits a memory file into the operator's half and the agent's.
 *
 * Pure, and the boundary the whole format exists for. A file with no heading is
 * entirely preamble — which is what makes an existing hand-written `memory.md`
 * safe the first time an agent touches it.
 */
export function parseSections(text: string): ParsedMemory {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.startsWith(SECTION_PREFIX));
  if (first === -1) return { preamble: text.trim(), sections: [] };

  const sections: MemorySection[] = [];
  let date = '';
  let body: string[] = [];

  const flush = (): void => {
    if (date !== '') sections.push({ date, body: body.join('\n').trim() });
  };

  for (const line of lines.slice(first)) {
    if (line.startsWith(SECTION_PREFIX)) {
      flush();
      date = line.slice(SECTION_PREFIX.length).trim();
      body = [];
    } else {
      body.push(line);
    }
  }
  flush();

  return { preamble: lines.slice(0, first).join('\n').trim(), sections };
}

/** `parseSections` in reverse. Exported so compaction can rebuild a file. */
export function renderMemoryFile(
  preamble: string,
  sections: readonly MemorySection[],
): string {
  const blocks = sections.map(
    (section) => `${SECTION_PREFIX}${section.date}\n\n${section.body}`,
  );
  const parts = preamble === '' ? blocks : [preamble, ...blocks];
  return parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
}

function memoryFile(workspaceRoot: string): string {
  return join(workspaceRoot, MEMORY_DIRNAME, MEMORY_FILENAME);
}

/** A missing file is the ordinary case; anything else is worth reporting. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function truncateBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;

  // Cut the bytes, then decode: a multi-byte character split down the middle
  // becomes one replacement character rather than corrupting what follows.
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');

  // That replacement character is *three* bytes, so a cut through a two-byte
  // character decodes to something longer than the cap it was meant to enforce.
  // Dropping the tail character is the only way the bound actually holds.
  return Buffer.byteLength(cut, 'utf8') > maxBytes ? cut.slice(0, -1) : cut;
}
