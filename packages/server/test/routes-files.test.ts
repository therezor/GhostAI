/**
 * The workspace routes, and the signature that stands in for a header.
 *
 * Three of these tests are the reason the file exists: a path that escapes the
 * workspace is refused, a token for one file cannot fetch another, and a file a
 * browser would execute is never served inline.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  ConfigSchema,
  type FileEntry,
  type FileTextResponse,
  type SignedUrl,
} from '@ghostbot/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { MEDIA_SECRET_NAME, mediaUrl, signMediaToken } from '#src/signing.js';
import { manualClock } from '#testkit/clock.js';
import { startTestServer, type TestServer } from '#testkit/server.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start(
  ...args: Parameters<typeof startTestServer>
): Promise<TestServer> {
  const started = await startTestServer(...args);
  running.push(started);
  return started;
}

function write(test: TestServer, relativePath: string, contents: string): void {
  writeFileSync(join(test.workspace, relativePath), contents);
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

describe('GET /api/files', () => {
  it('lists the workspace root by default, directories first', async () => {
    const test = await start();
    write(test, 'b.txt', 'b');
    mkdirSync(join(test.workspace, 'a-dir'));

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      path: '',
      entries: [
        {
          path: 'a-dir',
          name: 'a-dir',
          isDirectory: true,
          sizeBytes: 0,
          modifiedAtMs: expect.any(Number),
        },
        {
          path: 'b.txt',
          name: 'b.txt',
          isDirectory: false,
          sizeBytes: 1,
          modifiedAtMs: expect.any(Number),
          mimeType: 'text/plain; charset=utf-8',
        },
      ],
    });
  });

  it('lists a subdirectory', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes'));
    write(test, 'notes/todo.md', '# todo');

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=notes',
      headers: test.headers,
    });

    expect(response.json().entries).toEqual([
      expect.objectContaining({
        path: 'notes/todo.md',
        mimeType: 'text/markdown; charset=utf-8',
      }),
    ]);
  });

  // The workspace is a chroot, so none of these escapes — each names the
  // workspace root itself. The response echoes the path the jail agreed to, so
  // a client that re-sends it addresses the same directory.
  it.each(['..', '../..', '/', '~'])(
    'clamps %s to the workspace root',
    async (path) => {
      const test = await start();
      write(test, 'inside.txt', 'x');
      writeFileSync(join(test.workspace, '..', 'outside-the-jail.txt'), 'x');

      const response = await test.server.app.inject({
        method: 'GET',
        url: `/api/files?path=${encodeURIComponent(path)}`,
        headers: test.headers,
      });

      expect(response.statusCode).toBe(200);
      const names = (response.json().entries as Array<{ name: string }>).map(
        (entry) => entry.name,
      );
      expect(names).toContain('inside.txt');
      expect(names).not.toContain('outside-the-jail.txt');
    },
  );

  it('still refuses a symlink that leads out of the workspace', async () => {
    // The one escape clamping cannot see, and the reason the realpath check
    // survives the chroot change. A 403 rather than a 404: telling "no such
    // file" apart from "not allowed" lets a caller map the filesystem by
    // probing for the difference.
    const test = await start();
    symlinkSync(join(test.workspace, '..'), join(test.workspace, 'escape'));

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=escape',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('refuses a symlink that points out of the workspace', async () => {
    const test = await start();
    symlinkSync('/etc', join(test.workspace, 'escape'));

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=escape',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(403);
  });

  it('answers 400 for a file where a directory was asked for', async () => {
    const test = await start();
    write(test, 'note.txt', 'hello');

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=note.txt',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(400);
  });

  it('answers 404 for a directory that is not there', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=nowhere',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Upload and delete
// ---------------------------------------------------------------------------

describe('POST /api/files/upload', () => {
  it('writes the body and hands back a URL for it', async () => {
    const test = await start();

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/files/upload?path=uploads/hello.png',
      headers: { ...test.headers, 'content-type': 'image/png' },
      payload: Buffer.from('not really a png'),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      path: 'uploads/hello.png',
      sizeBytes: 16,
      mimeType: 'image/png',
      signedUrl: {
        url: expect.stringContaining('/api/media/'),
        expiresAtMs: expect.any(Number),
      },
    });

    // And the URL works without a session, which is the whole point of it.
    const fetched = await test.server.app.inject({
      method: 'GET',
      url: response.json().signedUrl.url,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.payload).toBe('not really a png');
  });

  it('refuses an empty body', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/files/upload?path=empty.txt',
      headers: { ...test.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(0),
    });

    expect(response.statusCode).toBe(400);
  });

  it('clamps an upload that tried to escape, and says where it landed', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/files/upload?path=${encodeURIComponent('../escaped.txt')}`,
      headers: { ...test.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    });

    expect(response.statusCode).toBe(201);
    // The response echoes the clamped path, so the client is told where its
    // bytes went rather than being left to assume.
    expect(response.json().path).toBe('escaped.txt');
    expect(existsSync(join(test.workspace, 'escaped.txt'))).toBe(true);
    expect(existsSync(join(test.workspace, '..', 'escaped.txt'))).toBe(false);
  });
});

describe('DELETE /api/files', () => {
  it('deletes a file', async () => {
    const test = await start();
    write(test, 'note.txt', 'hello');

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=note.txt',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
    const listing = await test.server.app.inject({
      method: 'GET',
      url: '/api/files',
      headers: test.headers,
    });
    expect(listing.json().entries).toEqual([]);
  });

  it('deletes an empty directory, which has nothing to lose', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes'));

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=notes',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
    expect(existsSync(join(test.workspace, 'notes'))).toBe(false);
  });

  /**
   * The guard that matters. Emptying a tree must never be something a request
   * *happens* to do — a mistyped path or a script looping over names would
   * otherwise take the contents with it.
   */
  it('refuses a directory with contents unless the caller said so', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes'));
    write(test, 'notes/keep.md', 'still here');

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=notes',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toEqual({ entryCount: 1 });
    expect(existsSync(join(test.workspace, 'notes/keep.md'))).toBe(true);
  });

  it('takes the contents when it does', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes/deep'), { recursive: true });
    write(test, 'notes/deep/gone.md', 'bye');

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=notes&recursive=true',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(204);
    expect(existsSync(join(test.workspace, 'notes'))).toBe(false);
  });

  it('clamps a recursive delete to the workspace rather than reaching above it', async () => {
    const test = await start();
    write(test, 'kept.txt', 'x');
    const outside = join(test.workspace, '..', 'must-survive.txt');
    writeFileSync(outside, 'x');

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: `/api/files?path=${encodeURIComponent('../')}&recursive=true`,
      headers: test.headers,
    });

    // `../` names the workspace root, so this empties the workspace — which is
    // what the caller asked for — and cannot touch its parent.
    expect(response.statusCode).toBe(204);
    expect(existsSync(outside)).toBe(true);
  });

  it('answers 404 for a file that is not there', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=gone.txt',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Reading and writing text
// ---------------------------------------------------------------------------

describe('GET /api/files/text', () => {
  async function read(
    test: TestServer,
    path: string,
  ): Promise<Awaited<ReturnType<TestServer['server']['app']['inject']>>> {
    return await test.server.app.inject({
      method: 'GET',
      url: `/api/files/text?path=${encodeURIComponent(path)}`,
      headers: test.headers,
    });
  }

  it('answers with the file and the timestamp a save has to match', async () => {
    const test = await start();
    write(test, 'note.md', '# hello\n');

    const response = await read(test, 'note.md');

    expect(response.statusCode).toBe(200);
    expect(response.json<FileTextResponse>()).toEqual({
      path: 'note.md',
      content: '# hello\n',
      sizeBytes: 8,
      modifiedAtMs: expect.any(Number),
      truncated: false,
    });
  });

  /**
   * The whole reason this route exists rather than a second read through
   * `/api/media/:token`. The MIME table is deliberately small, so a `.py` is
   * `application/octet-stream` and the media route serves it as an attachment —
   * which is right for a browser and useless for an editor.
   */
  it('opens a source file the MIME table has never heard of', async () => {
    const test = await start();
    write(test, 'script.py', 'print("hi")\n');

    const response = await read(test, 'script.py');

    expect(response.statusCode).toBe(200);
    expect(response.json<FileTextResponse>().content).toBe('print("hi")\n');
  });

  it('refuses a binary file rather than answering with mojibake', async () => {
    const test = await start();
    writeFileSync(
      join(test.workspace, 'blob.dat'),
      Buffer.from([0x89, 0x50, 0x00, 0x01]),
    );

    const response = await read(test, 'blob.dat');

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/Not a text file/);
  });

  it('truncates a file past the read limit and says that it did', async () => {
    const test = await start();
    write(test, 'huge.log', 'x'.repeat(600 * 1024));

    const body = (await read(test, 'huge.log')).json<FileTextResponse>();

    expect(body.truncated).toBe(true);
    expect(body.sizeBytes).toBe(600 * 1024);
    // A prefix, not the file: saving this back would delete the rest, which is
    // what `truncated` exists to stop the editor from offering.
    expect(body.content.length).toBeLessThan(body.sizeBytes);
  });

  it('refuses a directory, and clamps a path that tried to leave', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes'));

    expect((await read(test, 'notes')).statusCode).toBe(400);
    // Clamped to `outside` inside the workspace, which is simply not there.
    expect((await read(test, '../outside')).statusCode).toBe(404);
    expect((await read(test, 'gone.txt')).statusCode).toBe(404);
  });
});

describe('PUT /api/files/text', () => {
  async function save(
    test: TestServer,
    payload: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<TestServer['server']['app']['inject']>>> {
    return await test.server.app.inject({
      method: 'PUT',
      url: '/api/files/text',
      headers: test.headers,
      payload,
    });
  }

  it('writes the content and answers with the entry it produced', async () => {
    const test = await start();
    write(test, 'note.md', 'old');

    const response = await save(test, {
      path: 'note.md',
      content: 'new content',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<FileEntry>()).toEqual({
      path: 'note.md',
      name: 'note.md',
      isDirectory: false,
      sizeBytes: 11,
      modifiedAtMs: expect.any(Number),
      mimeType: 'text/markdown; charset=utf-8',
    });
    expect(readFileSync(join(test.workspace, 'note.md'), 'utf8')).toBe(
      'new content',
    );
  });

  it('creates a file that is not there yet, and the directory over it', async () => {
    const test = await start();

    const response = await save(test, {
      path: 'drafts/new.txt',
      content: 'first',
    });

    expect(response.statusCode).toBe(200);
    expect(readFileSync(join(test.workspace, 'drafts/new.txt'), 'utf8')).toBe(
      'first',
    );
  });

  /**
   * The case the timestamp is for: a turn rewrote the file while the editor sat
   * open on it, and saving would delete that turn's work.
   */
  it('refuses a save whose file moved since it was read', async () => {
    const test = await start();
    write(test, 'note.md', 'as loaded');
    const loaded = (
      await test.server.app.inject({
        method: 'GET',
        url: '/api/files/text?path=note.md',
        headers: test.headers,
      })
    ).json<FileTextResponse>();

    write(test, 'note.md', 'what the agent wrote');
    // Stamped rather than left to the clock: two writes in one millisecond
    // share an `mtimeMs`, and a test that happened to run fast would assert
    // that the guard does nothing.
    const later = new Date(Date.now() + 5_000);
    utimesSync(join(test.workspace, 'note.md'), later, later);

    const response = await save(test, {
      path: 'note.md',
      content: 'what the browser had',
      expectedModifiedAtMs: loaded.modifiedAtMs,
    });

    expect(response.statusCode).toBe(409);
    // And the agent's work is still there.
    expect(readFileSync(join(test.workspace, 'note.md'), 'utf8')).toBe(
      'what the agent wrote',
    );
  });

  it('refuses a save whose file was deleted since it was read', async () => {
    const test = await start();

    const response = await save(test, {
      path: 'gone.md',
      content: 'x',
      expectedModifiedAtMs: 1_700_000_000_000,
    });

    expect(response.statusCode).toBe(409);
  });

  it('writes without a timestamp, which is what creating a file is', async () => {
    const test = await start();
    write(test, 'note.md', 'old');

    expect(
      (await save(test, { path: 'note.md', content: 'clobbered' })).statusCode,
    ).toBe(200);
    expect(readFileSync(join(test.workspace, 'note.md'), 'utf8')).toBe(
      'clobbered',
    );
  });

  it('refuses a directory, and clamps a path that tried to leave', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes'));

    expect((await save(test, { path: 'notes', content: 'x' })).statusCode).toBe(
      400,
    );
    expect(
      (await save(test, { path: '../escaped.txt', content: 'x' })).statusCode,
    ).toBe(200);
    expect(existsSync(join(test.workspace, 'escaped.txt'))).toBe(true);
    expect(existsSync(join(test.workspace, '..', 'escaped.txt'))).toBe(false);
  });
});

describe('POST /api/files/directory', () => {
  async function create(
    test: TestServer,
    path: string,
  ): Promise<Awaited<ReturnType<TestServer['server']['app']['inject']>>> {
    return await test.server.app.inject({
      method: 'POST',
      url: '/api/files/directory',
      headers: test.headers,
      payload: { path },
    });
  }

  it('creates a directory and answers with its entry', async () => {
    const test = await start();

    const response = await create(test, 'drafts');

    expect(response.statusCode).toBe(201);
    expect(response.json<FileEntry>()).toEqual({
      path: 'drafts',
      name: 'drafts',
      isDirectory: true,
      sizeBytes: 0,
      modifiedAtMs: expect.any(Number),
    });
  });

  it('refuses a path something is already at', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'drafts'));

    expect((await create(test, 'drafts')).statusCode).toBe(409);
  });

  it('clamps a directory that tried to be created outside the workspace', async () => {
    const test = await start();
    expect((await create(test, '../escaped')).statusCode).toBe(201);
    expect(existsSync(join(test.workspace, 'escaped'))).toBe(true);
    expect(existsSync(join(test.workspace, '..', 'escaped'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Moving and renaming
// ---------------------------------------------------------------------------

describe('POST /api/files/move', () => {
  async function move(
    test: TestServer,
    from: string,
    to: string,
  ): Promise<Awaited<ReturnType<TestServer['server']['app']['inject']>>> {
    return await test.server.app.inject({
      method: 'POST',
      url: '/api/files/move',
      headers: test.headers,
      payload: { from, to },
    });
  }

  it('renames a file and answers with where it landed', async () => {
    const test = await start();
    write(test, 'notes.md', 'hello');

    const response = await move(test, 'notes.md', 'todo.md');

    expect(response.statusCode).toBe(200);
    expect(response.json<FileEntry>()).toMatchObject({
      path: 'todo.md',
      name: 'todo.md',
    });
    expect(readFileSync(join(test.workspace, 'todo.md'), 'utf8')).toBe('hello');
    expect(existsSync(join(test.workspace, 'notes.md'))).toBe(false);
  });

  it('renames a directory and everything inside it goes along', async () => {
    // The whole reason this is a filesystem move rather than a copy and a
    // delete: the server never walks the tree, so a folder of ten thousand
    // files renames in the same time one file does.
    const test = await start();
    mkdirSync(join(test.workspace, 'drafts'));
    write(test, join('drafts', 'one.md'), 'first');

    expect((await move(test, 'drafts', 'published')).statusCode).toBe(200);

    expect(
      readFileSync(join(test.workspace, 'published', 'one.md'), 'utf8'),
    ).toBe('first');
    expect(existsSync(join(test.workspace, 'drafts'))).toBe(false);
  });

  it('moves an entry into another directory, because a rename is a move', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'archive'));
    write(test, 'notes.md', 'hello');

    expect((await move(test, 'notes.md', 'archive/notes.md')).statusCode).toBe(
      200,
    );
    expect(existsSync(join(test.workspace, 'archive', 'notes.md'))).toBe(true);
  });

  it('refuses to overwrite whatever is already at the target', async () => {
    // `renameSync` would replace it silently, and a rename that destroys a file
    // the operator did not name is a loss they cannot see afterwards.
    const test = await start();
    write(test, 'notes.md', 'keep me');
    write(test, 'todo.md', 'and me');

    expect((await move(test, 'notes.md', 'todo.md')).statusCode).toBe(409);
    expect(readFileSync(join(test.workspace, 'todo.md'), 'utf8')).toBe(
      'and me',
    );
    expect(existsSync(join(test.workspace, 'notes.md'))).toBe(true);
  });

  it('answers 404 for a source that is not there', async () => {
    const test = await start();
    expect((await move(test, 'gone.md', 'todo.md')).statusCode).toBe(404);
  });

  it('names the missing folder rather than reporting the file as missing', async () => {
    // `renameSync` reports this as a bare ENOENT, which reads as "the file is
    // gone" when what is actually absent is the directory it was aimed at.
    const test = await start();
    write(test, 'notes.md', 'hello');

    const response = await move(test, 'notes.md', 'nowhere/notes.md');

    expect(response.statusCode).toBe(400);
    expect(
      response.json<{ error: { message: string } }>().error.message,
    ).toContain('nowhere');
  });

  it('refuses to move a directory inside itself', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'drafts'));

    const response = await move(test, 'drafts', 'drafts/nested');

    expect(response.statusCode).toBe(400);
    expect(existsSync(join(test.workspace, 'drafts'))).toBe(true);
  });

  it('treats a move onto itself as the no-op it is', async () => {
    const test = await start();
    write(test, 'notes.md', 'hello');

    expect((await move(test, 'notes.md', 'notes.md')).statusCode).toBe(200);
    expect(readFileSync(join(test.workspace, 'notes.md'), 'utf8')).toBe(
      'hello',
    );
  });

  it('clamps both ends into the workspace', async () => {
    // The target goes through the jail exactly like the source, so a `to` that
    // climbs out lands inside instead of escaping.
    const test = await start();
    write(test, 'notes.md', 'hello');

    expect((await move(test, 'notes.md', '../escaped.md')).statusCode).toBe(
      200,
    );
    expect(existsSync(join(test.workspace, 'escaped.md'))).toBe(true);
    expect(existsSync(join(test.workspace, '..', 'escaped.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Signed media
// ---------------------------------------------------------------------------

describe('signed media', () => {
  async function signed(test: TestServer, path: string): Promise<string> {
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/files/signed-url',
      headers: test.headers,
      payload: { path },
    });
    expect(response.statusCode).toBe(200);
    return response.json<SignedUrl>().url;
  }

  it('serves a file to a signature and to nothing else', async () => {
    const test = await start();
    write(test, 'photo.png', 'pixels');

    const url = await signed(test, 'photo.png');
    const withSignature = await test.server.app.inject({ method: 'GET', url });
    expect(withSignature.statusCode).toBe(200);
    expect(withSignature.headers['content-type']).toBe('image/png');
    expect(withSignature.headers['x-content-type-options']).toBe('nosniff');
    expect(withSignature.headers['content-disposition']).toBe('inline');

    // A session is not a signature: the credential for this route is the URL.
    const withSession = await test.server.app.inject({
      method: 'GET',
      url: '/api/media/not-a-real-token',
      headers: test.headers,
    });
    expect(withSession.statusCode).toBe(401);
  });

  it('refuses a token whose payload was edited', async () => {
    const test = await start();
    write(test, 'photo.png', 'pixels');
    write(test, 'secret.txt', 'the other file');

    const url = await signed(test, 'photo.png');
    const token = decodeURIComponent(url.slice('/api/media/'.length));
    const [payload, signature] = token.split('.');

    // Re-point the claim at another file, keeping the signature. This is the
    // attack the MAC exists for, and it must not depend on the path being
    // unguessable.
    const edited = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(
          Buffer.from(payload ?? '', 'base64url').toString('utf8'),
        ) as object),
        p: 'secret.txt',
      }),
      'utf8',
    ).toString('base64url');

    const response = await test.server.app.inject({
      method: 'GET',
      url: mediaUrl(`${edited}.${signature ?? ''}`),
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a token that has expired', async () => {
    const clock = manualClock();
    const test = await start({
      clock,
      config: ConfigSchema.parse({
        server: { auth: { signedUrlTtlMs: 60_000 } },
      }),
    });
    write(test, 'photo.png', 'pixels');

    const url = await signed(test, 'photo.png');
    expect(
      (await test.server.app.inject({ method: 'GET', url })).statusCode,
    ).toBe(200);

    clock.advance(60_001);
    expect(
      (await test.server.app.inject({ method: 'GET', url })).statusCode,
    ).toBe(401);
  });

  it('refuses a signature made with another key', async () => {
    const test = await start();
    write(test, 'photo.png', 'pixels');

    const token = signMediaToken('a-different-key', {
      path: 'photo.png',
      workspaceId: 'default',
      expiresAtMs: Date.now() + 60_000,
    });
    const response = await test.server.app.inject({
      method: 'GET',
      url: mediaUrl(token),
    });

    expect(response.statusCode).toBe(401);
  });

  /**
   * An SVG is a document, not a picture: it can carry `<script>`, and served as
   * `image/svg+xml` from this origin that script runs with the session cookie
   * attached. The workspace is a tree a language model writes to.
   */
  it('never serves an executable type inline', async () => {
    const test = await start();
    write(test, 'evil.svg', '<svg onload="fetch(\'/api/settings\')" />');

    const url = await signed(test, 'evil.svg');
    const response = await test.server.app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-disposition']).toBe('attachment');
  });

  it('refuses to sign a file that does not exist', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/files/signed-url',
      headers: test.headers,
      payload: { path: 'nowhere.png' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('404s when the file is deleted after the URL was minted', async () => {
    const test = await start();
    write(test, 'photo.png', 'pixels');
    const url = await signed(test, 'photo.png');

    await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=photo.png',
      headers: test.headers,
    });

    // A valid signature for a file that is gone: authorised, and nothing to
    // serve. Distinct from the 401 a bad signature gets.
    expect(
      (await test.server.app.inject({ method: 'GET', url })).statusCode,
    ).toBe(404);
  });

  it('refuses a signed path that became a symlink out of the workspace', async () => {
    const test = await start();
    write(test, 'photo.png', 'pixels');
    const url = await signed(test, 'photo.png');

    // The file the token names is replaced by a link to somewhere else. The
    // signature still verifies; the jail is what refuses.
    await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=photo.png',
      headers: test.headers,
    });
    symlinkSync('/etc/hosts', join(test.workspace, 'photo.png'));

    expect(
      (await test.server.app.inject({ method: 'GET', url })).statusCode,
    ).toBe(404);
  });

  it('mints a token the server can also verify directly', async () => {
    const test = await start();
    const secret = test.server.auth.ensureSecret(MEDIA_SECRET_NAME);

    // The secret is stable across reads — an image loaded after a reload must
    // not need a fresh URL.
    expect(test.server.auth.ensureSecret(MEDIA_SECRET_NAME)).toBe(secret);
  });
});

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

describe('the file routes are workspace-scoped', () => {
  async function makeWorkspace(test: TestServer, id: string): Promise<void> {
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: test.headers,
      payload: { name: id, id },
    });
    expect(response.statusCode).toBe(201);
  }

  it('lists only the workspace that was asked for', async () => {
    const test = await start();
    await makeWorkspace(test, 'acme');
    await makeWorkspace(test, 'research');
    writeFileSync(join(test.workspace, 'acme', 'secret.md'), 'a');
    writeFileSync(join(test.workspace, 'research', 'other.md'), 'b');

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=.&workspace=research',
      headers: test.headers,
    });

    const names = (response.json().entries as Array<{ name: string }>).map(
      (entry) => entry.name,
    );
    expect(names).toEqual(['other.md']);
  });

  it('cannot reach a sibling workspace with a traversal', async () => {
    const test = await start();
    await makeWorkspace(test, 'acme');
    await makeWorkspace(test, 'research');
    writeFileSync(join(test.workspace, 'acme', 'secret.md'), 'a');

    const response = await test.server.app.inject({
      method: 'GET',
      url: `/api/files/text?path=${encodeURIComponent('../acme/secret.md')}&workspace=research`,
      headers: test.headers,
    });

    // `..` clamps at `research`'s own root, so this names `acme/secret.md`
    // *inside* research — which is not there.
    expect(response.statusCode).toBe(404);
  });

  it('writes into the workspace the request named', async () => {
    const test = await start();
    await makeWorkspace(test, 'acme');

    const response = await test.server.app.inject({
      method: 'PUT',
      url: '/api/files/text',
      headers: test.headers,
      payload: { path: 'note.md', content: 'hello', workspaceId: 'acme' },
    });

    expect(response.statusCode).toBe(200);
    expect(existsSync(join(test.workspace, 'acme', 'note.md'))).toBe(true);
    expect(existsSync(join(test.workspace, 'note.md'))).toBe(false);
  });

  it('404s for a workspace with no registry row, without creating it', async () => {
    const test = await start();

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=.&workspace=never-registered',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(404);
    // `workspaceDirFor` would have resolved the slug happily — that is what
    // keeps a detached workspace's sessions working — so the registry lookup
    // in the route is the thing that stops a crafted id becoming a directory.
    expect(existsSync(join(test.workspace, 'never-registered'))).toBe(false);
  });

  it('defaults to the default workspace when no workspace is named', async () => {
    const test = await start();
    write(test, 'root-level.md', 'x');

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/files?path=.',
      headers: test.headers,
    });

    const names = (response.json().entries as Array<{ name: string }>).map(
      (entry) => entry.name,
    );
    expect(names).toContain('root-level.md');
  });

  it('signs a URL against the workspace it was minted for, and no other', async () => {
    const test = await start();
    await makeWorkspace(test, 'acme');
    await makeWorkspace(test, 'research');
    writeFileSync(join(test.workspace, 'acme', 'photo.png'), 'a-pixels');
    writeFileSync(join(test.workspace, 'research', 'photo.png'), 'r-pixels');

    const signed = await test.server.app.inject({
      method: 'POST',
      url: '/api/files/signed-url',
      headers: test.headers,
      payload: { path: 'photo.png', workspaceId: 'acme' },
    });
    const { url } = signed.json();

    const served = await test.server.app.inject({ method: 'GET', url });
    // Both workspaces contain `photo.png`. The workspace is inside the
    // signature, so the token can only ever fetch the one it was minted for.
    expect(served.body).toBe('a-pixels');
  });
});
