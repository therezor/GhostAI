/**
 * The agent-resolution policy, on its own.
 *
 * `routes-sessions.test.ts` covers this through the route; these cover the two
 * cases the route cannot easily reach and the one a second caller now depends
 * on — a chat channel asking for a conversation that has not been spoken in.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { userMessage } from '@ghostwire/core';

import { buildContextResponse } from '#src/context.js';

import { createFakeRuntime } from '#testkit/runtime.js';

const opened: Array<{ database: DatabaseSync; dir: string }> = [];

function runtime(): ReturnType<typeof createFakeRuntime> {
  const database = new DatabaseSync(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-context-'));
  opened.push({ database, dir });
  return createFakeRuntime({ database, workspace: dir });
}

afterEach(() => {
  while (opened.length > 0) {
    const entry = opened.pop();
    if (entry === undefined) continue;
    entry.database.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

describe('buildContextResponse', () => {
  it('says nothing for a session that does not exist', async () => {
    await expect(
      buildContextResponse(runtime(), 'nope'),
    ).resolves.toBeUndefined();
  });

  it('measures a session that has been spoken in', async () => {
    const fake = runtime();
    fake.store.ensureSession('web:1');
    fake.store.append('web:1', userMessage('hello'));

    const report = await buildContextResponse(fake, 'web:1');

    expect(report?.sessionKey).toBe('web:1');
    expect(report?.estimatedTokens).toBeGreaterThan(0);
    expect(report?.contextWindowTokens).toBeGreaterThan(0);
  });

  it('measures against the session’s own agent', async () => {
    // Its tools, its prompt and its window are what a turn here would carry;
    // a meter read against another agent's is simply wrong.
    const fake = runtime();
    fake.store.ensureSession('web:1', { agentId: 'default' });
    fake.store.append('web:1', userMessage('hello'));

    const report = await buildContextResponse(fake, 'web:1');

    expect(report?.agentId).toBe('default');
    expect(report?.requestedAgentId).toBeUndefined();
  });

  it('falls back to the default when the bound agent is gone, and says so', async () => {
    // A 404 would be wrong: the conversation lists and opens perfectly well,
    // and a turn in it *would* run — on the default.
    const fake = runtime();
    fake.store.ensureSession('web:1', { agentId: 'departed' });
    fake.store.append('web:1', userMessage('hello'));

    const report = await buildContextResponse(fake, 'web:1');

    expect(report?.requestedAgentId).toBe('departed');
    expect(report?.agentId).not.toBe('departed');
  });

  it('reports the breakdown a meter is drawn from', async () => {
    const fake = runtime();
    fake.store.ensureSession('web:1');
    fake.store.append('web:1', userMessage('hello'));

    const report = await buildContextResponse(fake, 'web:1');

    expect(Object.keys(report?.breakdown ?? {}).length).toBeGreaterThan(0);
  });
});
