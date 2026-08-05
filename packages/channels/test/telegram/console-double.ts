/**
 * A `TelegramConsole` over real stores.
 *
 * Real `SessionStore` and `WorkspaceStore` rather than stubs, following what
 * `packages/server/test/testkit/runtime.ts` does: those two are the parts worth
 * testing against, because a command's whole job is what it does to them, and a
 * stub that returns what the test already assumes proves nothing. The stores
 * are in-memory SQLite, so a suite still finishes in milliseconds.
 *
 * Only the four provider-shaped members are canned, because there is no
 * provider here to answer them.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  SessionStore,
  WorkspaceStore,
  resolveGhostPaths,
  type Clock,
} from '@ghostai/core';
import type {
  AgentSummary,
  ContextResponse,
  ModelsResponse,
} from '@ghostai/protocol';

import type { MemoryState, TelegramConsole } from '#src/telegram/console.js';

const NOW = 1_700_000_000_000;

const fixedClock: Clock = {
  now: () => NOW,
  monotonic: () => 0,
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle);
  },
  sleep: () => Promise.resolve(),
};

export interface FakeConsole extends TelegramConsole {
  /** Models `setModel` was asked for, in order. */
  readonly modelsSet: readonly string[];
  /** Replaces what `agents()` answers. */
  setAgents(agents: readonly AgentSummary[]): void;
  /** Replaces what `context()` answers. */
  setContext(report: ContextResponse | undefined): void;
  /** Replaces what `memory()` answers. */
  setMemory(state: MemoryState): void;
  /** Sessions `compressMemory` was called for, in order. */
  readonly compressed: readonly string[];
  close(): void;
}

const DEFAULT_MEMORY: MemoryState = {
  granted: true,
  tokens: 0,
  historyTokens: 0,
  suggestAboveTokens: 32_768,
};

const DEFAULT_AGENTS: readonly AgentSummary[] = [
  { id: 'default', label: 'Default', model: 'gpt-4o', provider: 'openai' },
  { id: 'researcher', label: 'Researcher', model: 'o3', provider: 'openai' },
];

const DEFAULT_MODELS: ModelsResponse = {
  models: [
    { id: 'gpt-4o', providerId: 'openai' },
    { id: 'o3', providerId: 'openai' },
  ],
  errors: {},
};

export function fakeConsole(): FakeConsole {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-telegram-'));
  const database = new DatabaseSync(join(dir, 'ghost.db'));
  const store = new SessionStore({ database, clock: fixedClock });
  // A real store needs somewhere to make a workspace's directory. The temp
  // directory is both the install root and the workspace root, which is what
  // `packages/server/test/testkit/runtime.ts` does for the same reason.
  const workspaces = new WorkspaceStore({
    database,
    paths: resolveGhostPaths({ root: dir, workspace: dir }),
    clock: fixedClock,
  });

  let agents = DEFAULT_AGENTS;
  let report: ContextResponse | undefined;
  let memory: MemoryState = DEFAULT_MEMORY;
  const modelsSet: string[] = [];
  const compressed: string[] = [];

  return {
    store,
    workspaces,
    agents: () => agents,
    models: () => Promise.resolve(DEFAULT_MODELS),
    setModel: (id) => {
      modelsSet.push(id);
    },
    context: () => Promise.resolve(report),
    memory: () => Promise.resolve(memory),
    compressMemory: (sessionKey) => {
      compressed.push(sessionKey);
      return Promise.resolve({ folded: 12, tokens: 340 });
    },
    modelsSet,
    compressed,
    setAgents: (next) => {
      agents = next;
    },
    setContext: (next) => {
      report = next;
    },
    setMemory: (next) => {
      memory = next;
    },
    close: () => {
      database.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
