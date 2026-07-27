/**
 * A running server over a fake runtime, for the route tests.
 *
 * Everything a route needs and nothing it does not: an in-memory database, a
 * temp-directory workspace, a cheap password hasher, and a bearer token that
 * already authenticates. The point is that a test asserting what
 * `GET /api/sessions` returns should be three lines long, and that the setup it
 * skips is setup no route test should have an opinion about.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { Clock } from '@ghostai/core';
import { ConfigSchema, type Config, type ToolDefinition } from '@ghostai/protocol';

import { createServer, type GhostServer } from '../app.js';
import type { PasswordHasher } from '../auth-store.js';
import { createFakeRuntime, type FakeRuntime } from './runtime.js';

/** argon2id is ~50 ms a call by design; a route test cannot pay it per case. */
export const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake:${password}`,
  verify: async (digest, password) => digest === `fake:${password}`,
};

export const TEST_PASSWORD = 'a-test-password';

export interface TestServerOptions {
  readonly config?: Config;
  readonly tools?: readonly ToolDefinition[];
  readonly credentialsPresent?: Readonly<Record<string, boolean>>;
  readonly provider?: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  /** Drives the store, the signer and the session TTL together. */
  readonly clock?: Clock;
}

export interface TestServer {
  readonly server: GhostServer;
  readonly runtime: FakeRuntime;
  /** The jail root. Tests write fixtures straight into it. */
  readonly workspace: string;
  /** A `Bearer` header that authenticates every `required` route. */
  readonly headers: Record<string, string>;
  close(): Promise<void>;
}

export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const database = new DatabaseSync(':memory:');
  const workspace = mkdtempSync(join(tmpdir(), 'ghostai-routes-'));
  const config = options.config ?? ConfigSchema.parse({});

  const runtime = createFakeRuntime({
    database,
    workspace,
    config,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.credentialsPresent === undefined
      ? {}
      : { credentialsPresent: options.credentialsPresent }),
  });

  const server = await createServer({
    config,
    runtime,
    database,
    hasher: fakeHasher,
    password: TEST_PASSWORD,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  return {
    server,
    runtime,
    workspace,
    headers: { authorization: `Bearer ${server.auth.issue('test').token}` },
    close: async () => {
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
