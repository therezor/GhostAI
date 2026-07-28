import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGhostError, type GhostError } from '@ghostai/core';

import { toToolResult, type AnyTool, type ToolContext } from '../define.js';
import { createTestWorkspace, type TestWorkspace } from '../testkit/workspace.js';
import { editFileTool } from './edit-file.js';
import { listDirTool } from './list-dir.js';
import { formatBytes } from './shared.js';
import { readFileTool } from './read-file.js';
import { writeFileTool } from './write-file.js';

let workspace: TestWorkspace;
let context: ToolContext;
let root: string;

beforeEach(() => {
  workspace = createTestWorkspace();
  context = workspace.context;
  root = workspace.root;
});

afterEach(() => {
  workspace.dispose();
});

/** Runs a tool and returns the error it threw, typed. */
async function failure(tool: AnyTool, args: unknown, ctx = context): Promise<GhostError> {
  const error = await tool.run(args, ctx).then(
    () => null,
    (value: unknown) => value,
  );
  if (!isGhostError(error)) throw new Error(`expected a GhostError, got ${String(error)}`);
  return error;
}

async function text(tool: AnyTool, args: unknown, ctx = context): Promise<string> {
  return toToolResult(await tool.run(args, ctx)).content;
}

describe('read_file', () => {
  it('reads a workspace file', async () => {
    writeFileSync(join(root, 'notes.md'), 'hello\nworld\n');
    await expect(text(readFileTool, { path: 'notes.md' })).resolves.toBe('hello\nworld\n');
  });

  it('reads a file in a subdirectory', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'index.ts'), 'export {};');
    await expect(text(readFileTool, { path: 'src/index.ts' })).resolves.toBe('export {};');
  });

  it('reports a missing file as not_found against the relative path', async () => {
    const error = await failure(readFileTool, { path: 'absent.md' });
    expect(error.kind).toBe('not_found');
    // The absolute path would be copied back by the model and then rejected by
    // the jail, so the message stays in the contract's own vocabulary.
    expect(error.message).toBe('absent.md does not exist.');
    expect(error.message).not.toContain(root);
  });

  it('refuses a directory and points at the tool that handles it', async () => {
    mkdirSync(join(root, 'src'));
    const error = await failure(readFileTool, { path: 'src' });
    expect(error.kind).toBe('invalid_input');
    expect(error.message).toContain('list_dir');
  });

  it('refuses to dump a binary file into the context', async () => {
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    const error = await failure(readFileTool, { path: 'logo.png' });
    expect(error.kind).toBe('invalid_input');
    expect(error.message).toContain('binary');
  });

  it('says so rather than returning nothing for an empty file', async () => {
    writeFileSync(join(root, 'empty.txt'), '');
    await expect(text(readFileTool, { path: 'empty.txt' })).resolves.toContain('is empty');
  });

  it('bounds the read by the output budget rather than the file size', async () => {
    writeFileSync(join(root, 'huge.txt'), 'a'.repeat(200_000));
    const result = await text(
      readFileTool,
      { path: 'huge.txt' },
      workspace.with({ maxOutputChars: 100 }),
    );
    expect(result).toContain('showing the first 400 of 200000 bytes');
    expect(result.length).toBeLessThan(600);
  });

  it('returns a line window', async () => {
    writeFileSync(join(root, 'lines.txt'), ['one', 'two', 'three', 'four'].join('\n'));
    await expect(text(readFileTool, { path: 'lines.txt', offset: 2, limit: 2 })).resolves.toBe(
      'two\nthree',
    );
  });

  it('reads to the end when only an offset is given', async () => {
    writeFileSync(join(root, 'lines.txt'), ['one', 'two', 'three'].join('\n'));
    await expect(text(readFileTool, { path: 'lines.txt', offset: 3 })).resolves.toBe('three');
  });

  it('reports an offset past the end instead of returning nothing', async () => {
    writeFileSync(join(root, 'lines.txt'), 'one\ntwo');
    await expect(text(readFileTool, { path: 'lines.txt', offset: 99 })).resolves.toContain(
      'past the end',
    );
  });

  it.each([
    ['a traversal', '../secret', 'secret'],
    ['an absolute path', '/etc/passwd', 'etc/passwd'],
    ['a home prefix', '~/.ssh/id_rsa', '.ssh/id_rsa'],
  ])('clamps %s into the workspace and says where it looked', async (_name, path, landed) => {
    // The workspace is a chroot, so none of these is a refusal — each names a
    // file inside the workspace that happens not to exist. What matters is that
    // the model is told so: an unexplained ENOENT on `/etc/passwd` reads as
    // "the host has no passwd file", which is a lie in the other direction.
    const error = await failure(readFileTool, { path });
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain(landed);
    expect(error.message).toContain('The workspace is the root');
  });

  it('says where it read from when a clamped path does exist', async () => {
    writeFileSync(join(root, 'passwd'), 'not the real one');
    const result = await text(readFileTool, { path: '/passwd' });
    expect(result).toContain('not the real one');
    // The success path needs the note as much as the failure path: content came
    // back, and without this the model believes it holds the host's file.
    expect(result).toContain('"/passwd" was resolved to "passwd"');
  });

  it('rejects a symlink pointing out of the workspace', async () => {
    const outside = join(root, '..', 'outside.txt');
    writeFileSync(outside, 'stolen');
    symlinkSync(outside, join(root, 'link.txt'));
    expect((await failure(readFileTool, { path: 'link.txt' })).kind).toBe('jail_escape');
  });
});

describe('write_file', () => {
  it('writes a file and reports its size', async () => {
    const result = await text(writeFileTool, { path: 'out.txt', content: 'hello' });
    expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('hello');
    expect(result).toBe('Wrote 5 B to out.txt.');
  });

  it('creates parent directories', async () => {
    await text(writeFileTool, { path: 'a/b/c.txt', content: 'deep' });
    expect(readFileSync(join(root, 'a', 'b', 'c.txt'), 'utf8')).toBe('deep');
  });

  it('replaces existing contents', async () => {
    writeFileSync(join(root, 'out.txt'), 'old');
    await text(writeFileTool, { path: 'out.txt', content: 'new' });
    expect(readFileSync(join(root, 'out.txt'), 'utf8')).toBe('new');
  });

  it('reports writing over a directory as invalid input', async () => {
    mkdirSync(join(root, 'src'));
    expect((await failure(writeFileTool, { path: 'src', content: 'x' })).kind).toBe(
      'invalid_input',
    );
  });

  it('clamps a write that tried to escape, and lands it inside the workspace', async () => {
    const result = toToolResult(
      await writeFileTool.run({ path: '../escape.txt', content: 'x' }, context),
    );

    expect(readFileSync(join(root, 'escape.txt'), 'utf8')).toBe('x');
    expect(existsSync(join(root, '..', 'escape.txt'))).toBe(false);
    expect(result.content).toContain('"../escape.txt" was resolved to "escape.txt"');
  });

  it('still refuses a symlink that leads out of the workspace', async () => {
    // Clamping is lexical; this is the escape it cannot see, and the reason the
    // realpath check has to survive the chroot change.
    const outside = join(root, '..', 'target.txt');
    writeFileSync(outside, 'stolen');
    symlinkSync(outside, join(root, 'link.txt'));
    expect((await failure(writeFileTool, { path: 'link.txt', content: 'x' })).kind).toBe(
      'jail_escape',
    );
    expect(readFileSync(outside, 'utf8')).toBe('stolen');
  });

  it('refuses a dangling symlink rather than creating its target outside', async () => {
    // The bug the lstat guard closes: `realpath` reports ENOENT for a broken
    // link exactly as it does for an absent name, so the boundary walk used to
    // hand back a contained path that `writeFile` then followed straight out.
    const outside = join(root, '..', 'planted.txt');
    symlinkSync(outside, join(root, 'decoy.txt'));

    expect((await failure(writeFileTool, { path: 'decoy.txt', content: 'x' })).kind).toBe(
      'jail_escape',
    );
    expect(existsSync(outside)).toBe(false);
  });

  it('carries the byte count for the audit log', async () => {
    const result = toToolResult(
      await writeFileTool.run({ path: 'x.txt', content: 'héllo' }, context),
    );
    expect(result.details).toEqual({ path: 'x.txt', bytes: 6 });
  });
});

describe('edit_file', () => {
  beforeEach(() => {
    writeFileSync(join(root, 'code.ts'), 'const a = 1;\nconst b = 2;\n');
  });

  it('replaces a unique string', async () => {
    const result = await text(editFileTool, {
      path: 'code.ts',
      oldText: 'const b = 2;',
      newText: 'const b = 3;',
    });
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('const a = 1;\nconst b = 3;\n');
    expect(result).toContain('Replaced 1 occurrence in code.ts');
  });

  it('refuses an ambiguous edit rather than guessing', async () => {
    writeFileSync(join(root, 'code.ts'), 'x();\nx();\n');
    const error = await failure(editFileTool, {
      path: 'code.ts',
      oldText: 'x();',
      newText: 'y();',
    });
    expect(error.kind).toBe('conflict');
    expect(error.message).toContain('occurs 2 times');
    // Nothing was written.
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('x();\nx();\n');
  });

  it('replaces every occurrence when asked', async () => {
    writeFileSync(join(root, 'code.ts'), 'x();\nx();\n');
    const result = await text(editFileTool, {
      path: 'code.ts',
      oldText: 'x();',
      newText: 'y();',
      replaceAll: true,
    });
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('y();\ny();\n');
    expect(result).toContain('Replaced 2 occurrences');
  });

  it('refuses the string "false" for replaceAll rather than reading it as true', async () => {
    // `z.coerce.boolean()` is `Boolean(value)`, which would turn this into an
    // instruction to replace everything.
    const parsed = editFileTool.parseArgs({
      path: 'code.ts',
      oldText: 'a',
      newText: 'b',
      replaceAll: 'false',
    });
    expect(parsed.ok).toBe(false);
  });

  it('reports text that is not there, with advice', async () => {
    const error = await failure(editFileTool, {
      path: 'code.ts',
      oldText: 'const c = 3;',
      newText: 'x',
    });
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('exactly');
  });

  it('refuses a no-op edit', async () => {
    const error = await failure(editFileTool, { path: 'code.ts', oldText: 'a', newText: 'a' });
    expect(error.kind).toBe('invalid_input');
  });

  it('reports a missing file', async () => {
    expect(
      (await failure(editFileTool, { path: 'gone.ts', oldText: 'a', newText: 'b' })).kind,
    ).toBe('not_found');
  });

  it('writes $ patterns literally', async () => {
    // `String.replace` with a replacement *string* reads `$&` as "the match".
    writeFileSync(join(root, 'code.ts'), 'PRICE');
    await text(editFileTool, { path: 'code.ts', oldText: 'PRICE', newText: '$& $1 $` costs $5' });
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('$& $1 $` costs $5');
  });

  it('writes $ patterns literally with replaceAll too', async () => {
    writeFileSync(join(root, 'code.ts'), 'A A');
    await text(editFileTool, { path: 'code.ts', oldText: 'A', newText: '$&', replaceAll: true });
    expect(readFileSync(join(root, 'code.ts'), 'utf8')).toBe('$& $&');
  });

  it('reports the size delta for the audit log', async () => {
    const result = toToolResult(
      await editFileTool.run(
        { path: 'code.ts', oldText: 'const a = 1;', newText: 'let a=1;' },
        context,
      ),
    );
    expect(result.details).toMatchObject({ occurrences: 1, delta: -4 });
  });
});

describe('list_dir', () => {
  it('lists directories first, then files with sizes', async () => {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'a.txt'), 'aaa');
    writeFileSync(join(root, 'b.txt'), 'bb');
    const result = await text(listDirTool, {});
    expect(result.split('\n')).toEqual(['src/', 'a.txt (3 B)', 'b.txt (2 B)']);
  });

  it('defaults to the workspace root', async () => {
    writeFileSync(join(root, 'a.txt'), 'a');
    await expect(text(listDirTool, {})).resolves.toBe('a.txt (1 B)');
  });

  it('hides nothing', async () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, '.env'), 'SECRET=1');
    const result = await text(listDirTool, {});
    expect(result).toContain('node_modules/');
    expect(result).toContain('.env');
  });

  it('walks subdirectories when asked', async () => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    writeFileSync(join(root, 'src', 'deep', 'x.ts'), 'x');
    const result = await text(listDirTool, { path: '.', recursive: true });
    expect(result).toContain(join('src', 'deep', 'x.ts'));
  });

  it('caps the listing and says how much it dropped', async () => {
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(join(root, `f${String(index)}.txt`), 'x');
    }
    const result = await text(listDirTool, { path: '.', maxEntries: 3 });
    expect(result.split('\n')).toHaveLength(4);
    expect(result).toContain('7 more entries not shown');
  });

  it('says a directory is empty', async () => {
    mkdirSync(join(root, 'empty'));
    await expect(text(listDirTool, { path: 'empty' })).resolves.toContain('is empty');
  });

  it('reports a missing directory', async () => {
    expect((await failure(listDirTool, { path: 'nope' })).kind).toBe('not_found');
  });

  it('clamps a listing that tried to escape back to the workspace root', async () => {
    writeFileSync(join(root, 'inside.txt'), 'x');
    writeFileSync(join(root, '..', 'outside-the-jail.txt'), 'x');

    const listing = await text(listDirTool, { path: '..' });
    expect(listing).toContain('inside.txt');
    expect(listing).not.toContain('outside-the-jail.txt');
    expect(listing).toContain('[list_dir:');
  });

  it('marks an unreadable entry rather than failing the whole listing', async () => {
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
    writeFileSync(join(root, 'fine.txt'), 'x');
    const result = await text(listDirTool, {});
    expect(result).toContain('broken (unreadable)');
    expect(result).toContain('fine.txt (1 B)');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [10 * 1024, '10 KB'],
    [1024 * 1024, '1.0 MB'],
    [3 * 1024 ** 4, '3.0 TB'],
    [4096 * 1024 ** 4, '4096 TB'],
  ])('renders %i as %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
