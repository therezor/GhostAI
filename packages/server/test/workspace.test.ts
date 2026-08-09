import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceJail } from '@ghostwire/security';
import { afterEach, describe, expect, it } from 'vitest';

import { inlineSafe, listDirectory } from '#src/workspace.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop() ?? '', { recursive: true, force: true });
  }
});

/**
 * The jail's *canonical* root, which is the only path worth building fixtures
 * against: on macOS `os.tmpdir()` is a symlink into `/private/var`, and a
 * directory handed to `listDirectory` under its uncanonical name is a directory
 * the jail does not recognise as its own. Every caller in the routes passes a
 * path the jail returned, so this matches how it is really used.
 */
function workspace(): { root: string; jail: WorkspaceJail } {
  const created = mkdtempSync(join(tmpdir(), 'ghostai-workspace-'));
  roots.push(created);
  const jail = new WorkspaceJail({ root: created });
  return { root: jail.root, jail };
}

// `mimeTypeFor` and `readText` moved to `@ghostwire/core` and are covered by
// `core/test/workspace-files.test.ts`.

describe('inlineSafe', () => {
  it.each(['photo.png', 'notes.md', 'data.json'])('allows %s', (path) => {
    expect(inlineSafe(path)).toBe(true);
  });

  // Each of these executes in the origin that served it. An SVG is the one that
  // surprises people: it is a document with a `<script>` element.
  it.each(['evil.svg', 'page.html', 'bundle.js', 'module.mjs', 'doc.xml'])(
    'refuses to inline %s',
    (path) => {
      expect(inlineSafe(path)).toBe(false);
    },
  );
});

describe('listDirectory', () => {
  it('puts directories first, then sorts by name', () => {
    const { root, jail } = workspace();
    writeFileSync(join(root, 'b.txt'), 'b');
    writeFileSync(join(root, 'a.txt'), 'a');
    mkdirSync(join(root, 'z-dir'));
    mkdirSync(join(root, 'a-dir'));

    expect(listDirectory(jail, root).map((entry) => entry.name)).toEqual([
      'a-dir',
      'z-dir',
      'a.txt',
      'b.txt',
    ]);
  });

  it('reports workspace-relative paths, never absolute ones', () => {
    const { root, jail } = workspace();
    mkdirSync(join(root, 'notes'));
    writeFileSync(join(root, 'notes', 'todo.md'), '# todo');

    const entries = listDirectory(jail, join(root, 'notes'));
    expect(entries[0]?.path).toBe(join('notes', 'todo.md'));
    expect(entries[0]?.path.startsWith('/')).toBe(false);
  });

  // Listing it would advertise a file the jail then refuses to open, and
  // `relative()` would throw on the way to saying so.
  it('drops a symlink pointing out of the workspace', () => {
    const { root, jail } = workspace();
    writeFileSync(join(root, 'inside.txt'), 'here');
    symlinkSync('/etc', join(root, 'escape'));

    expect(listDirectory(jail, root).map((entry) => entry.name)).toEqual([
      'inside.txt',
    ]);
  });

  it('skips an entry that vanished between readdir and stat', () => {
    const { root, jail } = workspace();
    // A dangling symlink is the same case as a file deleted mid-listing: it is
    // named by `readdir` and gone by `stat`. One missing row beats a failure.
    symlinkSync(join(root, 'never-existed'), join(root, 'dangling'));
    writeFileSync(join(root, 'real.txt'), 'here');

    expect(listDirectory(jail, root).map((entry) => entry.name)).toEqual([
      'real.txt',
    ]);
  });

  it('reports a directory with no size', () => {
    const { root, jail } = workspace();
    mkdirSync(join(root, 'notes'));

    const entry = listDirectory(jail, root)[0];
    expect(entry).toMatchObject({ isDirectory: true, sizeBytes: 0 });
    // No MIME type at all rather than a guess: a directory is not a document,
    // and `application/octet-stream` on one would invite a client to fetch it.
    expect(entry?.mimeType).toBeUndefined();
  });
});
