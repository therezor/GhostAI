/**
 * `GET /api/skills` — the catalogue the composer's `@skill:` autocomplete reads.
 *
 * The route exists because the catalogue previously lived only in the model's
 * prompt and on disk, which is everywhere except the screen of the person typing
 * the mention. What it must never do is grow into a second way of *reading* a
 * skill: the body's one destination is the prompt, so the assertions below pin
 * the response to names and descriptions.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** A skill in the jail root, as an operator would commit one. */
function writeSkill(
  workspace: string,
  name: string,
  description: string,
  body = `Body of ${name}.`,
): void {
  const dir = join(workspace, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

describe('GET /api/skills', () => {
  it('answers with the workspace catalogue, sorted by name', async () => {
    const started = await start();
    writeSkill(started.workspace, 'release-notes', 'Draft release notes.');
    writeSkill(started.workspace, 'code-review', 'Review a diff.');

    const response = await started.server.app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: started.headers,
    });

    expect(response.statusCode).toBe(200);
    // Sorted, and the same order the prompt's index carries — `readSkills`
    // sorts so a `readdir` order that varies between hosts cannot move the
    // cached prefix.
    expect(response.json()).toEqual({
      skills: [
        { name: 'code-review', description: 'Review a diff.' },
        { name: 'release-notes', description: 'Draft release notes.' },
      ],
    });
  });

  it('never answers with a body', async () => {
    // The load-bearing assertion. A sheet runs to 12 KB and its one destination
    // is the prompt; a client holding a copy would be holding it to show
    // nothing, and this response is fetched every time someone types `@skill:`.
    const started = await start();
    writeSkill(
      started.workspace,
      'deploy',
      'Ship a release.',
      'Run the migration first, then flip the flag.',
    );

    const response = await started.server.app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: started.headers,
    });

    expect(response.body).not.toContain('flip the flag');
  });

  it('answers with an empty list when the workspace has no skills folder', async () => {
    // Not a 404: a workspace with nothing in `skills/` is the ordinary state of
    // a fresh install, and the autocomplete asks before anyone has written one.
    const started = await start();

    const response = await started.server.app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: started.headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ skills: [] });
  });

  it('refuses a workspace the registry does not have', async () => {
    // The registry lookup before the jail, exactly as the files routes do it:
    // `jailFor` resolves any legal slug on purpose, so the question of whether
    // a caller may see this workspace has to be asked by the route.
    const started = await start();

    const response = await started.server.app.inject({
      method: 'GET',
      url: '/api/skills?workspace=not-a-workspace',
      headers: started.headers,
    });

    expect(response.statusCode).toBe(404);
  });

  it('requires authentication', async () => {
    const started = await start();

    const response = await started.server.app.inject({
      method: 'GET',
      url: '/api/skills',
    });

    expect(response.statusCode).toBe(401);
  });

  it('skips a malformed skill rather than failing the listing', async () => {
    // The loader's rule, asserted through the route: a folder in a workspace is
    // whatever a person or a previous turn left there, and a listing that
    // refuses because one sheet lacks a description is worse than one that
    // returns the other three.
    const started = await start();
    writeSkill(started.workspace, 'good', 'Fine.');
    mkdirSync(join(started.workspace, 'skills', 'empty'), { recursive: true });

    const response = await started.server.app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: started.headers,
    });

    expect(response.json()).toEqual({
      skills: [{ name: 'good', description: 'Fine.' }],
    });
  });
});
