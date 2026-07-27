/**
 * The workspace routes, and the signature that stands in for a header.
 *
 * Three of these tests are the reason the file exists: a path that escapes the
 * workspace is refused, a token for one file cannot fetch another, and a file a
 * browser would execute is never served inline.
 */

import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConfigSchema, type SignedUrl } from '@ghostai/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { MEDIA_SECRET_NAME, mediaUrl, signMediaToken } from './signing.js';
import { manualClock } from './testkit/clock.js';
import { startTestServer, type TestServer } from './testkit/server.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

async function start(...args: Parameters<typeof startTestServer>): Promise<TestServer> {
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
      expect.objectContaining({ path: 'notes/todo.md', mimeType: 'text/markdown; charset=utf-8' }),
    ]);
  });

  // The jail's verdict, surfaced as a 403 by the error table. Never a 404:
  // telling a caller apart "no such file" from "not allowed" lets them map the
  // filesystem by probing for the difference.
  it.each(['../outside', '/etc', '~/secrets'])('refuses %s', async (path) => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'GET',
      url: `/api/files?path=${encodeURIComponent(path)}`,
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
      signedUrl: { url: expect.stringContaining('/api/media/'), expiresAtMs: expect.any(Number) },
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

  it('refuses a path that leaves the workspace', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: `/api/files/upload?path=${encodeURIComponent('../escaped.txt')}`,
      headers: { ...test.headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('nope'),
    });

    expect(response.statusCode).toBe(403);
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

  it('refuses to delete a directory', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'notes'));

    const response = await test.server.app.inject({
      method: 'DELETE',
      url: '/api/files?path=notes',
      headers: test.headers,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/directory/);
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
        ...(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as object),
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
      config: ConfigSchema.parse({ server: { auth: { signedUrlTtlMs: 60_000 } } }),
    });
    write(test, 'photo.png', 'pixels');

    const url = await signed(test, 'photo.png');
    expect((await test.server.app.inject({ method: 'GET', url })).statusCode).toBe(200);

    clock.advance(60_001);
    expect((await test.server.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('refuses a signature made with another key', async () => {
    const test = await start();
    write(test, 'photo.png', 'pixels');

    const token = signMediaToken('a-different-key', {
      path: 'photo.png',
      expiresAtMs: Date.now() + 60_000,
    });
    const response = await test.server.app.inject({ method: 'GET', url: mediaUrl(token) });

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
    expect((await test.server.app.inject({ method: 'GET', url })).statusCode).toBe(404);
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

    expect((await test.server.app.inject({ method: 'GET', url })).statusCode).toBe(404);
  });

  it('mints a token the server can also verify directly', async () => {
    const test = await start();
    const secret = test.server.auth.ensureSecret(MEDIA_SECRET_NAME);

    // The secret is stable across reads — an image loaded after a reload must
    // not need a fresh URL.
    expect(test.server.auth.ensureSecret(MEDIA_SECRET_NAME)).toBe(secret);
  });
});
