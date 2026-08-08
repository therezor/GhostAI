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

import type { Clock } from '@ghostbot/core';
import {
  ConfigSchema,
  type Config,
  type ExtensionCommand,
  type ExtensionStatus,
  type McpServerStatus,
  type RunCommandRequest,
  type RunCommandResponse,
  type ToolDefinition,
} from '@ghostbot/protocol';

import { createServer, type GhostServer, type UiOptions } from '#src/app.js';
import type { PasswordHasher } from '#src/auth-store.js';
import type { SessionHub } from '#src/hub.js';
import type { SchedulerPort } from '#src/scheduler.js';
import { createTestHub, type FakeRunner } from './hub.js';
import { createFakeRuntime, type FakeRuntime } from './runtime.js';

/** argon2id is ~50 ms a call by design; a route test cannot pay it per case. */
export const fakeHasher: PasswordHasher = {
  hash: async (password) => `fake:${password}`,
  verify: async (digest, password) => digest === `fake:${password}`,
};

export const TEST_PASSWORD = 'a-test-password';

export interface TestServerOptions {
  readonly config?: Config;
  /** What the default agent advertises — what a context inspector would list. */
  readonly tools?: readonly ToolDefinition[];
  /** What the registry holds. Defaults to `tools`; see `FakeRuntimeOptions`. */
  readonly registeredTools?: readonly ToolDefinition[];
  readonly credentialsPresent?: Readonly<Record<string, boolean>>;
  /** Omitted leaves the port's optional method absent. See `FakeRuntimeOptions`. */
  readonly mcpServers?: readonly McpServerStatus[];
  /** Omitted leaves the port's methods absent — a build with no host. */
  readonly extensions?: readonly ExtensionStatus[];
  readonly commands?: readonly ExtensionCommand[];
  readonly runCommand?: (
    id: string,
    input: RunCommandRequest,
  ) => RunCommandResponse;
  readonly provider?: string;
  readonly model?: string;
  /** `false` drives the routes as a fresh install with no provider or model. */
  readonly configured?: boolean;
  readonly systemPrompt?: string;
  /** Stands in for the config file `POST /api/settings/reload` re-reads. */
  readonly onReload?: () => Config;
  /** Drives the store, the signer and the session TTL together. */
  readonly clock?: Clock;
  /** What the scripted turn behind the socket answers with. */
  readonly answer?: string;
  /** A runner to use instead of the instant one — see `hangingRunner`. */
  readonly runner?: FakeRunner;
  /** A built UI to serve, with the SPA fallback that goes with it. */
  readonly ui?: UiOptions;
  /**
   * Stands in for the engine, which a route test has no business starting.
   *
   * `SchedulerPort` is two methods and a flag on purpose: a test that wants to
   * assert `POST .../run` answers 202 supplies an object, and a test that wants
   * to assert it refuses without one supplies nothing.
   */
  readonly scheduler?: SchedulerPort;
}

export interface TestServer {
  readonly server: GhostServer;
  readonly runtime: FakeRuntime;
  readonly hub: SessionHub;
  /** Every turn the socket's scripted loop was asked to run. */
  readonly runner: FakeRunner;
  /** The jail root. Tests write fixtures straight into it. */
  readonly workspace: string;
  /** The automation store the routes read, so a test can seed a job directly. */
  readonly automation: GhostServer['automation'];
  /** A `Bearer` header that authenticates every `required` route. */
  readonly headers: Record<string, string>;
  close(): Promise<void>;
}

export async function startTestServer(
  options: TestServerOptions = {},
): Promise<TestServer> {
  const database = new DatabaseSync(':memory:');
  const workspace = mkdtempSync(join(tmpdir(), 'ghostai-routes-'));
  const config = options.config ?? ConfigSchema.parse({});

  const runtime = createFakeRuntime({
    database,
    workspace,
    config,
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.registeredTools === undefined
      ? {}
      : { registeredTools: options.registeredTools }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.configured === undefined
      ? {}
      : { configured: options.configured }),
    ...(options.systemPrompt === undefined
      ? {}
      : { systemPrompt: options.systemPrompt }),
    ...(options.onReload === undefined ? {} : { onReload: options.onReload }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.credentialsPresent === undefined
      ? {}
      : { credentialsPresent: options.credentialsPresent }),
    ...(options.mcpServers === undefined
      ? {}
      : { mcpServers: options.mcpServers }),
    ...(options.extensions === undefined
      ? {}
      : { extensions: options.extensions }),
    ...(options.commands === undefined ? {} : { commands: options.commands }),
    ...(options.runCommand === undefined
      ? {}
      : { runCommand: options.runCommand }),
  });

  const { hub, runner } = createTestHub(
    runtime.store,
    config,
    options.answer,
    options.runner,
  );

  const server = await createServer({
    config,
    runtime,
    hub,
    database,
    hasher: fakeHasher,
    password: TEST_PASSWORD,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    ...(options.scheduler === undefined
      ? {}
      : { scheduler: () => options.scheduler }),
  });

  return {
    server,
    runtime,
    hub,
    runner,
    workspace,
    automation: server.automation,
    headers: { authorization: `Bearer ${server.auth.issue('test').token}` },
    close: async () => {
      hub.close();
      await server.close();
      database.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
