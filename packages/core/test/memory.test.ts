import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type Logger } from '#src/logger.js';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_MEMORIES,
  MEMORY_MAX_BYTES,
  memorySlug,
  readMemories,
  renderIndex,
  renderMemory,
  saveMemory,
  type MemoryInput,
} from '#src/memory.js';
import { parseFrontmatter } from '#src/frontmatter.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/**
 * A disposable workspace root.
 *
 * `realpath` is not optional: macOS hands out `/var/folders/…`, a symlink into
 * `/private/var`, and a test that compares the path it wrote against the path it
 * read back passes on Linux and fails on a reviewer's laptop without it.
 */
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-memory-')));
  roots.push(root);
  return root;
}

/** Writes one file into `memory/` verbatim, frontmatter and all. */
function install(root: string, name: string, contents: string): void {
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', name), contents);
}

function fixture(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    name: 'ui-stack-preferences',
    description: 'no shadcn/ui; Tailwind in rem, not px',
    type: 'user',
    body: 'The user wants an explicit design token layer.',
    ...overrides,
  };
}

function indexOf(root: string): string {
  return readFileSync(join(root, 'memory', 'MEMORY.md'), 'utf8');
}

interface Capture {
  readonly logger: Logger;
  readonly messages: () => string[];
}

function capture(): Capture {
  const chunks: string[] = [];
  const logger = createLogger({
    level: 'warn',
    destination: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
  });
  return {
    logger,
    messages: () =>
      chunks.map((chunk) => (JSON.parse(chunk) as { msg?: string }).msg ?? ''),
  };
}

describe('memorySlug', () => {
  it('passes a name that is already one through', () => {
    expect(memorySlug('run-full-ci-gate')).toBe('run-full-ci-gate');
  });

  it('slugs a name a person would type', () => {
    // The useful answer, rather than a refusal that costs a round trip to
    // learn a rule that could just be applied.
    expect(memorySlug('UI Stack Preferences')).toBe('ui-stack-preferences');
  });

  it('cannot produce a name that leaves the folder', () => {
    // The guarantee the tool used to get for free by taking no path at all.
    expect(memorySlug('../../etc/passwd')).toBe('etc-passwd');
    expect(memorySlug('a/b')).toBe('a-b');
    expect(memorySlug('..')).toBeUndefined();
  });

  it('is undefined when nothing usable is left', () => {
    expect(memorySlug('???')).toBeUndefined();
    expect(memorySlug('   ')).toBeUndefined();
  });

  it('refuses the index, whatever case it is asked for in', () => {
    // `MEMORY.md` is generated. A memory called `memory` is the same path on a
    // case-insensitive filesystem, and would be replaced by the next save.
    expect(memorySlug('memory')).toBeUndefined();
    expect(memorySlug('MEMORY')).toBeUndefined();
  });

  it('does not end a name on the separator the cap landed on', () => {
    const long = `${'a'.repeat(63)} tail`;
    expect(memorySlug(long)).toBe('a'.repeat(63));
  });
});

describe('renderMemory', () => {
  it('round-trips through the frontmatter parser', () => {
    // The one coupling worth an assertion: the file is written with a *nested*
    // `metadata.type`, and read back through a parser that flattens it to a
    // dotted key. A change to either end that broke this would otherwise show
    // up as memories silently losing their kind.
    const { fields, body } = parseFrontmatter(renderMemory(fixture()));

    expect(fields.name).toBe('ui-stack-preferences');
    expect(fields.description).toBe('no shadcn/ui; Tailwind in rem, not px');
    expect(fields['metadata.type']).toBe('user');
    expect(body).toBe('The user wants an explicit design token layer.');
  });

  it('collapses a description that arrived on two lines', () => {
    // An index is one line per memory, so a description with a break in it
    // would put a memory's second half on a line of its own.
    const text = renderMemory(fixture({ description: 'one\n  two' }));
    expect(text).toContain('description: one two');
  });
});

describe('renderIndex', () => {
  it('links each memory relatively, with its kind', async () => {
    const root = workspace();
    await saveMemory(root, fixture());

    // Relative, because this file sits *inside* `memory/` and is read by a
    // person with an editor open on the folder.
    expect(indexOf(root)).toContain(
      '- [ui-stack-preferences](ui-stack-preferences.md) _(user)_ — no shadcn/ui; Tailwind in rem, not px',
    );
  });

  it('says so when there is nothing, rather than rendering a bare heading', () => {
    expect(renderIndex([])).toContain('_Nothing recorded yet._');
  });
});

describe('readMemories', () => {
  it('is empty for a workspace that has none', async () => {
    await expect(readMemories(workspace())).resolves.toEqual([]);
  });

  it('says nothing about a workspace that simply has no memory', async () => {
    // The ordinary case, not a misconfiguration. A warning here would fire on
    // every turn of every workspace that has not started remembering.
    const { logger, messages } = capture();
    await readMemories(workspace(), { logger });
    expect(messages()).toEqual([]);
  });

  it('sorts by name', async () => {
    // The result lands in the provider's cached prefix, and `readdir` order
    // varies between hosts.
    const root = workspace();
    await saveMemory(root, fixture({ name: 'zeta' }));
    await saveMemory(root, fixture({ name: 'alpha' }));

    const memories = await readMemories(root);
    expect(memories.map((memory) => memory.name)).toEqual(['alpha', 'zeta']);
  });

  it('carries the path the model hands to read_file', async () => {
    const root = workspace();
    await saveMemory(root, fixture({ name: 'alpha' }));

    const [memory] = await readMemories(root);
    expect(memory?.path).toBe('memory/alpha.md');
  });

  it('skips the generated index rather than advertising it', async () => {
    const root = workspace();
    await saveMemory(root, fixture());

    // `MEMORY.md` is written from these files. Reading it back as one of them
    // would advertise a memory whose body is a list of the others.
    const memories = await readMemories(root);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.name).toBe('ui-stack-preferences');
  });

  it('skips a memory.md left by the format this replaced, silently', async () => {
    // On a case-sensitive filesystem it is a separate file with no frontmatter.
    // Warning about it would fire on every turn, forever, about a file the
    // operator was told would be left alone.
    const root = workspace();
    const { logger, messages } = capture();
    install(root, 'memory.md', 'Always deploy with `make release`.\n');

    await expect(readMemories(root, { logger })).resolves.toEqual([]);
    expect(messages()).toEqual([]);
  });

  it('ignores a file that is not markdown', async () => {
    const root = workspace();
    install(root, 'notes.txt', 'not a memory');
    await expect(readMemories(root)).resolves.toEqual([]);
  });

  it('skips a memory with no description, and says why', async () => {
    // The description is the entire basis on which a model opens the file, so
    // an index line for one without it teaches it the memory is about nothing.
    const root = workspace();
    const { logger, messages } = capture();
    install(root, 'broken.md', '---\nname: broken\n---\n\nA body.\n');

    await expect(readMemories(root, { logger })).resolves.toEqual([]);
    expect(messages()).toEqual(['memory has no description; skipped']);
  });

  it('reads an unrecognised kind as project, and warns', async () => {
    // Kept, not dropped: refusing would lose a fact over a label.
    const root = workspace();
    const { logger, messages } = capture();
    install(
      root,
      'odd.md',
      '---\ndescription: something\nmetadata:\n  type: nonsense\n---\n\nBody.\n',
    );

    const memories = await readMemories(root, { logger });
    expect(memories[0]?.type).toBe('project');
    expect(messages()).toEqual([
      'memory has an unrecognised metadata.type; read as project',
    ]);
  });

  it('reads a hand-written memory with no kind as project, silently', async () => {
    const root = workspace();
    const { logger, messages } = capture();
    install(
      root,
      'handwritten.md',
      '---\ndescription: typed by hand\n---\n\nB.\n',
    );

    const memories = await readMemories(root, { logger });
    expect(memories[0]?.type).toBe('project');
    expect(messages()).toEqual([]);
  });

  it('bounds what it reads, on a character boundary', async () => {
    // Cut the bytes then decode, so a multi-byte character split down the
    // middle costs one replacement character rather than everything after it.
    const root = workspace();
    const head = '---\ndescription: big\n---\n\n';
    install(root, 'big.md', head + 'é'.repeat(MEMORY_MAX_BYTES));

    const [memory] = await readMemories(root);
    expect(Buffer.byteLength(memory?.body ?? '', 'utf8')).toBeLessThanOrEqual(
      MEMORY_MAX_BYTES,
    );
  });

  it('caps how many it advertises, and says so', async () => {
    const root = workspace();
    for (let n = 0; n <= MAX_MEMORIES; n += 1) {
      install(
        root,
        `m${String(n).padStart(4, '0')}.md`,
        '---\ndescription: one\nmetadata:\n  type: project\n---\n\nB.\n',
      );
    }

    const { logger, messages } = capture();
    const memories = await readMemories(root, { logger });

    expect(memories).toHaveLength(MAX_MEMORIES);
    expect(messages()).toEqual([
      'more memory files than the cap; the rest are not advertised',
    ]);
  });

  it('costs one memory when a file cannot be read, not the call', async () => {
    const root = workspace();
    await saveMemory(root, fixture({ name: 'good' }));
    // A directory named like a memory is not one, and `readdir` already filters
    // it — so the case that reaches `readFile` is an unreadable *file*.
    mkdirSync(join(root, 'memory', 'a-directory.md'));

    const memories = await readMemories(root);
    expect(memories.map((memory) => memory.name)).toEqual(['good']);
  });
});

describe('saveMemory', () => {
  it('creates the folder and writes a memory the reader can load back', async () => {
    const root = workspace();
    const result = await saveMemory(root, fixture());

    expect(result).toEqual({
      name: 'ui-stack-preferences',
      path: 'memory/ui-stack-preferences.md',
      replaced: false,
      total: 1,
    });
    const [memory] = await readMemories(root);
    expect(memory?.description).toBe('no shadcn/ui; Tailwind in rem, not px');
    expect(memory?.type).toBe('user');
  });

  it('replaces a memory of the same name rather than adding a second', async () => {
    // The whole of how a model corrects itself. Without it the index carries
    // two contradictory lines with nothing to say which is current.
    const root = workspace();
    await saveMemory(root, fixture({ body: 'The old answer.' }));
    const result = await saveMemory(root, fixture({ body: 'The new answer.' }));

    expect(result.replaced).toBe(true);
    expect(result.total).toBe(1);
    const [memory] = await readMemories(root);
    expect(memory?.body).toBe('The new answer.');
  });

  it('regenerates the index on every save', async () => {
    const root = workspace();
    await saveMemory(root, fixture({ name: 'alpha' }));
    await saveMemory(root, fixture({ name: 'zeta' }));

    const text = indexOf(root);
    expect(text).toContain('(alpha.md)');
    expect(text).toContain('(zeta.md)');
  });

  it('reports the name it actually used', async () => {
    const root = workspace();
    const result = await saveMemory(
      root,
      fixture({ name: 'Build Conventions' }),
    );

    expect(result.name).toBe('build-conventions');
    expect(result.path).toBe('memory/build-conventions.md');
  });

  it('leaves no temp file behind', async () => {
    // A crash between the write and the rename is what the temp file exists
    // for; one still on disk afterwards would be indexed as a memory.
    const root = workspace();
    await saveMemory(root, fixture());

    const entries = readdirSync(join(root, 'memory'));
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('moves aside a memory.md that resolves to the index path', async () => {
    // On a case-insensitive filesystem `memory/memory.md` *is* `MEMORY.md`, so
    // writing the generated index over it would replace an operator's notes
    // from the format this one replaced.
    const root = workspace();
    const target = join(root, 'memory', 'MEMORY.md');
    install(root, 'MEMORY.md', 'Always deploy with `make release`.\n');

    await saveMemory(root, fixture());

    expect(readFileSync(`${target}.replaced`, 'utf8')).toBe(
      'Always deploy with `make release`.\n',
    );
    expect(readFileSync(target, 'utf8')).toContain('(ui-stack-preferences.md)');
  });

  it('overwrites an index it wrote itself, without moving it aside', async () => {
    const root = workspace();
    await saveMemory(root, fixture({ name: 'alpha' }));
    await saveMemory(root, fixture({ name: 'zeta' }));

    const entries = readdirSync(join(root, 'memory'));
    expect(entries.filter((name) => name.endsWith('.replaced'))).toEqual([]);
  });

  it('serialises concurrent saves so the index holds both', async () => {
    // The one behaviour with no other way to be caught. Each save is a
    // read-modify-write of the *folder* — write the file, then regenerate the
    // index from everything in it — so two running together would each write an
    // index that did not know about the other's file.
    const root = workspace();
    await Promise.all([
      saveMemory(root, fixture({ name: 'alpha' })),
      saveMemory(root, fixture({ name: 'zeta' })),
    ]);

    const text = indexOf(root);
    expect(text).toContain('(alpha.md)');
    expect(text).toContain('(zeta.md)');
  });

  it('refuses a name that is not usable as a filename', async () => {
    // Checked here as well as in the tool, because this is the function that
    // turns a string into a path.
    await expect(
      saveMemory(workspace(), fixture({ name: '???' })),
    ).rejects.toThrow(/not usable as a filename/);
  });
});
