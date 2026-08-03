/**
 * The workspace manager over HTTP.
 *
 * The two properties worth holding: a request can never name a *path*, and a
 * delete never removes files — it detaches, and it refuses outright while
 * sessions still point at the workspace.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

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

async function create(
  test: TestServer,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return await test.server.app.inject({
    method: 'POST',
    url: '/api/workspaces',
    headers: test.headers,
    payload,
  });
}

async function list(
  test: TestServer,
): Promise<Array<{ id: string; name: string }>> {
  const response = await test.server.app.inject({
    method: 'GET',
    url: '/api/workspaces',
    headers: test.headers,
  });
  return response.json<{ workspaces: Array<{ id: string; name: string }> }>()
    .workspaces;
}

describe('GET /api/workspaces', () => {
  it('always has a default, and it is first', async () => {
    const test = await start();
    await create(test, { name: 'Alpha' });

    const workspaces = await list(test);
    expect(workspaces[0]).toMatchObject({ id: 'default', name: 'Default' });
    expect(workspaces.map((workspace) => workspace.id)).toEqual([
      'default',
      'alpha',
    ]);
  });

  it('reports the session count a delete would have to move', async () => {
    const test = await start();
    await create(test, { name: 'Acme' });
    await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: test.headers,
      payload: { key: 'web-1', workspaceId: 'acme' },
    });

    const workspaces = await list(test);
    expect(
      workspaces.find((workspace) => workspace.id === 'acme'),
    ).toMatchObject({
      sessionCount: 1,
    });
  });

  it('never reports a path', async () => {
    const test = await start();
    await create(test, { name: 'Acme' });

    const response = await test.server.app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers: test.headers,
    });

    // A workspace is `<root>/workspace/<id>` and the id is all that crosses the
    // wire. A path field would make "managed directories only" a convention.
    expect(response.payload).not.toContain(test.workspace);
    expect(response.payload).not.toContain('/');
  });
});

describe('POST /api/workspaces', () => {
  it('creates a workspace and its folder from a name alone', async () => {
    const test = await start();
    const response = await create(test, { name: 'Client Acme' });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      id: 'client-acme',
      isDefault: false,
    });
    expect(existsSync(join(test.workspace, 'client-acme'))).toBe(true);
  });

  it('refuses an id that could be a path', async () => {
    const test = await start();
    // 422, the same code a schema violation gets: the store's `invalid_input`
    // and Zod's rejection are the same class of answer to the caller.
    for (const id of ['../escape', 'a/b', '~home', 'Work', 'ws-']) {
      expect((await create(test, { name: 'Nope', id })).statusCode).toBe(422);
    }
    expect(existsSync(join(test.workspace, '..', 'escape'))).toBe(false);
  });

  it('refuses a reserved id', async () => {
    const test = await start();
    expect(
      (await create(test, { name: 'Nope', id: 'default' })).statusCode,
    ).toBe(422);
    expect((await create(test, { name: 'Nope', id: 'con' })).statusCode).toBe(
      422,
    );
  });

  it('refuses a duplicate', async () => {
    const test = await start();
    await create(test, { name: 'Notes', id: 'notes' });
    expect(
      (await create(test, { name: 'Notes', id: 'notes' })).statusCode,
    ).toBe(409);
  });

  it('adopts an existing folder, which is what makes delete-then-recreate work', async () => {
    const test = await start();
    mkdirSync(join(test.workspace, 'research'), { recursive: true });
    writeFileSync(join(test.workspace, 'research', 'notes.md'), 'kept');

    expect(
      (await create(test, { name: 'Research', id: 'research' })).statusCode,
    ).toBe(201);
    expect(existsSync(join(test.workspace, 'research', 'notes.md'))).toBe(true);
  });

  it('refuses a slug that collides with a file', async () => {
    const test = await start();
    writeFileSync(join(test.workspace, 'notes'), 'not a folder');
    expect(
      (await create(test, { name: 'Notes', id: 'notes' })).statusCode,
    ).toBe(409);
  });
});

describe('PATCH /api/workspaces/:id', () => {
  it('renames without moving anything on disk', async () => {
    const test = await start();
    await create(test, { name: 'Old', id: 'acme' });

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/acme',
      headers: test.headers,
      payload: { name: 'New' },
    });

    expect(response.json()).toMatchObject({ id: 'acme', name: 'New' });
    // A rename that relocated the tree would break every session bound to it
    // and every signed URL still in flight.
    expect(existsSync(join(test.workspace, 'acme'))).toBe(true);
  });

  it('moves the folder, and the sessions that named it come with it', async () => {
    const test = await start();
    await create(test, { name: 'Client Acme', id: 'acme' });
    writeFileSync(join(test.workspace, 'acme', 'notes.md'), 'kept');
    await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: test.headers,
      payload: { key: 'web-1', workspaceId: 'acme' },
    });

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/acme',
      headers: test.headers,
      payload: { id: 'acme24' },
    });

    expect(response.json()).toMatchObject({
      id: 'acme24',
      name: 'Client Acme',
    });
    expect(existsSync(join(test.workspace, 'acme'))).toBe(false);
    expect(existsSync(join(test.workspace, 'acme24', 'notes.md'))).toBe(true);
    // The half that is not the store's: a folder that moved without its
    // conversations is worse than either half on its own.
    expect(
      (await list(test)).find((workspace) => workspace.id === 'acme24'),
    ).toMatchObject({
      sessionCount: 1,
    });
  });

  it('takes the name and the folder in one request', async () => {
    const test = await start();
    await create(test, { name: 'Old', id: 'acme' });

    const response = await test.server.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/acme',
      headers: test.headers,
      payload: { name: 'Client Acme', id: 'acme24' },
    });

    expect(response.json()).toMatchObject({
      id: 'acme24',
      name: 'Client Acme',
    });
  });

  it('refuses to move the default, whose folder holds all the others', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/default',
      headers: test.headers,
      payload: { id: 'elsewhere' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('refuses a folder that could be a path, or that is taken', async () => {
    const test = await start();
    await create(test, { name: 'Alpha', id: 'alpha' });
    await create(test, { name: 'Beta', id: 'beta' });

    const move = async (id: string): Promise<number> =>
      (
        await test.server.app.inject({
          method: 'PATCH',
          url: '/api/workspaces/beta',
          headers: test.headers,
          payload: { id },
        })
      ).statusCode;

    // 422 for the same reason a create with that id gets one: the store's
    // `invalid_input` and Zod's rejection are one class of answer to a caller.
    expect(await move('../etc')).toBe(422);
    expect(await move('alpha')).toBe(409);
    expect(existsSync(join(test.workspace, 'beta'))).toBe(true);
  });

  it('404s for a workspace that is not there', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'PATCH',
      url: '/api/workspaces/ghost',
      headers: test.headers,
      payload: { name: 'New' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DELETE /api/workspaces/:id', () => {
  async function remove(
    test: TestServer,
    id: string,
  ): Promise<LightMyRequestResponse> {
    return await test.server.app.inject({
      method: 'DELETE',
      url: `/api/workspaces/${id}`,
      headers: test.headers,
    });
  }

  it('detaches and keeps the files', async () => {
    const test = await start();
    await create(test, { name: 'Research', id: 'research' });
    writeFileSync(join(test.workspace, 'research', 'notes.md'), 'kept');

    expect((await remove(test, 'research')).statusCode).toBe(204);
    expect((await list(test)).map((workspace) => workspace.id)).toEqual([
      'default',
    ]);
    // The whole reason delete detaches: there is no undo for removing a tree
    // someone has been working in, and one click is all it takes to ask.
    expect(existsSync(join(test.workspace, 'research', 'notes.md'))).toBe(true);
  });

  it('refuses while sessions still point at it, and says how many', async () => {
    const test = await start();
    await create(test, { name: 'Acme', id: 'acme' });
    for (const key of ['web-1', 'web-2']) {
      await test.server.app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: test.headers,
        payload: { key, workspaceId: 'acme' },
      });
    }

    const response = await remove(test, 'acme');
    expect(response.statusCode).toBe(409);
    // The count is what the UI's "move them to Default first" affordance
    // renders, so it belongs in the error rather than only in the message.
    expect(response.json().error.details).toMatchObject({ sessionCount: 2 });
  });

  it('refuses the default', async () => {
    const test = await start();
    expect((await remove(test, 'default')).statusCode).toBe(409);
  });

  it('404s for a workspace that is not there', async () => {
    const test = await start();
    expect((await remove(test, 'ghost')).statusCode).toBe(404);
  });

  it('goes through once the sessions have been moved', async () => {
    const test = await start();
    await create(test, { name: 'Acme', id: 'acme' });
    await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: test.headers,
      payload: { key: 'web-1', workspaceId: 'acme' },
    });

    const moved = await test.server.app.inject({
      method: 'POST',
      url: '/api/workspaces/acme/sessions/move',
      headers: test.headers,
      payload: { to: 'default' },
    });

    expect(moved.json()).toEqual({ moved: 1 });
    expect((await remove(test, 'acme')).statusCode).toBe(204);
  });
});

describe('POST /api/workspaces/:id/sessions/move', () => {
  it('404s when the destination does not exist', async () => {
    const test = await start();
    await create(test, { name: 'Acme', id: 'acme' });

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/workspaces/acme/sessions/move',
      headers: test.headers,
      payload: { to: 'nowhere' },
    });

    // Moving into a workspace nobody can name would strand the conversations
    // somewhere the UI cannot show them — worse than the delete it unblocks.
    expect(response.statusCode).toBe(404);
  });

  it('refuses a move into itself', async () => {
    const test = await start();
    await create(test, { name: 'Acme', id: 'acme' });

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/workspaces/acme/sessions/move',
      headers: test.headers,
      payload: { to: 'acme' },
    });

    expect(response.statusCode).toBe(409);
  });
});

describe('sessions and workspaces', () => {
  it('refuses to open a session in a workspace that does not exist', async () => {
    const test = await start();
    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: test.headers,
      payload: { key: 'web-1', workspaceId: 'nowhere' },
    });

    // `ensureSession` would store any string. A conversation bound to a
    // workspace the manager cannot list is one the UI can never show files for.
    expect(response.statusCode).toBe(404);
  });

  it('records the workspace and reports it back', async () => {
    const test = await start();
    await create(test, { name: 'Acme', id: 'acme' });

    const response = await test.server.app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: test.headers,
      payload: { key: 'web-1', workspaceId: 'acme' },
    });

    expect(response.json()).toMatchObject({
      key: 'web-1',
      workspaceId: 'acme',
    });
  });
});
