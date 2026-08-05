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
  MEMORY_MAX_BYTES,
  appendMemory,
  parseSections,
  readMemory,
  renderMemoryFile,
  writeMemory,
} from '#src/memory.js';

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

function install(root: string, contents: string): void {
  mkdirSync(join(root, 'memory'), { recursive: true });
  writeFileSync(join(root, 'memory', 'memory.md'), contents);
}

function stored(root: string): string {
  return readFileSync(join(root, 'memory', 'memory.md'), 'utf8');
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

describe('readMemory', () => {
  it('is undefined for a workspace that has none', async () => {
    await expect(readMemory(workspace())).resolves.toBeUndefined();
  });

  it('says nothing about a workspace that simply has no memory', async () => {
    // The ordinary case, not a misconfiguration. A warning here would fire on
    // every turn of every workspace that has not started remembering.
    const log = capture();
    await readMemory(workspace(), { logger: log.logger });
    expect(log.messages()).toEqual([]);
  });

  it('reads the file back', async () => {
    const root = workspace();
    install(root, 'Remember this.\n');
    await expect(readMemory(root)).resolves.toBe('Remember this.\n');
  });

  it('warns when a file exists but cannot be read', async () => {
    // A directory where the file should be: someone meant this to work, so
    // unlike the missing case it is worth a line.
    const root = workspace();
    mkdirSync(join(root, 'memory', 'memory.md'), { recursive: true });
    const log = capture();

    await expect(
      readMemory(root, { logger: log.logger }),
    ).resolves.toBeUndefined();
    expect(log.messages()).toContain('memory file could not be read');
  });

  it('bounds what it reads, and never on a half character', async () => {
    const root = workspace();
    // A boundary that lands mid-character: 'é' is two bytes, so the cut splits
    // one. The replacement character that decoding produces is *three* bytes,
    // so a naive cut-then-decode returns something larger than the cap — which
    // is the bug this asserts against, not a hypothetical.
    install(root, `${'a'.repeat(MEMORY_MAX_BYTES - 1)}é`);

    const text = await readMemory(root);
    expect(Buffer.byteLength(text ?? '', 'utf8')).toBeLessThanOrEqual(
      MEMORY_MAX_BYTES,
    );
    expect(text).not.toMatch(/�/u);
  });
});

describe('appendMemory', () => {
  it('creates the folder and the file', async () => {
    const root = workspace();
    await appendMemory(root, '- Prefers rem over px.', '2026-08-05T10:00:00Z');

    expect(stored(root)).toBe(
      '## Session 2026-08-05\n\n- Prefers rem over px.\n',
    );
  });

  it('never rewrites what is already there', async () => {
    // The property the whole format exists for. A second append on a later day
    // must leave the first day's text byte-identical.
    const root = workspace();
    await appendMemory(root, '- The first fact.', '2026-08-05T10:00:00Z');
    const first = stored(root);

    await appendMemory(root, '- The second fact.', '2026-08-07T10:00:00Z');

    expect(stored(root).startsWith(first.trimEnd())).toBe(true);
    expect(stored(root)).toContain('## Session 2026-08-07');
  });

  it('joins the day it is already on rather than opening a second heading', async () => {
    const root = workspace();
    await appendMemory(root, '- One.', '2026-08-05T10:00:00Z');
    await appendMemory(root, '- Two.', '2026-08-05T18:00:00Z');

    const text = stored(root);
    expect(text.match(/## Session/gu)).toHaveLength(1);
    expect(text).toContain('- One.\n- Two.');
  });

  it('leaves prose above the first heading alone', async () => {
    const root = workspace();
    install(root, 'Always deploy with `make release`.\n');

    await appendMemory(root, '- A fact.', '2026-08-05T10:00:00Z');

    expect(stored(root)).toBe(
      'Always deploy with `make release`.\n\n## Session 2026-08-05\n\n- A fact.\n',
    );
  });

  it('ignores an empty note rather than opening an empty section', async () => {
    const root = workspace();
    await appendMemory(root, '   \n  ', '2026-08-05T10:00:00Z');
    expect(readdirSync(root)).toEqual([]);
  });
});

describe('writeMemory', () => {
  it('replaces the file and leaves no temporary behind', async () => {
    // The absent `.tmp` is the assertion that proves the rename happened rather
    // than a plain write — a half-written memory is one the next turn inlines.
    const root = workspace();
    await writeMemory(root, 'first\n');
    await writeMemory(root, 'second\n');

    expect(stored(root)).toBe('second\n');
    expect(readdirSync(join(root, 'memory'))).toEqual(['memory.md']);
  });
});

describe('parseSections', () => {
  it('treats a file with no heading as entirely the operator’s', async () => {
    // What makes an existing hand-written memory.md safe the first time an
    // agent touches it.
    expect(parseSections('Just some prose.')).toEqual({
      preamble: 'Just some prose.',
      sections: [],
    });
  });

  it('splits the preamble from the dated sections', () => {
    const parsed = parseSections(
      'Preamble.\n\n## Session 2026-08-05\n\n- One.\n\n## Session 2026-08-07\n\n- Two.\n',
    );

    expect(parsed.preamble).toBe('Preamble.');
    expect(parsed.sections).toEqual([
      { date: '2026-08-05', body: '- One.' },
      { date: '2026-08-07', body: '- Two.' },
    ]);
  });

  it('round-trips through render', () => {
    const text = 'Preamble.\n\n## Session 2026-08-05\n\n- One.\n';
    const parsed = parseSections(text);
    expect(renderMemoryFile(parsed.preamble, parsed.sections)).toBe(text);
  });

  it('renders nothing at all for an empty memory', () => {
    expect(renderMemoryFile('', [])).toBe('');
  });
});
