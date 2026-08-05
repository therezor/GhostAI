/**
 * Telegram, wired into `ghost serve`.
 *
 * Two things live here, and both are here rather than in `@ghostai/channels`
 * for the same reason: this is the composition root, and it is the only place
 * that has a credential vault and an environment to read. `ChannelContext` has
 * neither, deliberately — a channel that could open the vault could read every
 * provider key in it.
 *
 *  - **Resolving the bot token.** Vault first, then the environment, then the
 *    config file, which is the order `credentials.ts` already uses for provider
 *    keys and for the same reason: the vault is the documented home, and a
 *    token sitting in `config.json` is plaintext on disk.
 *
 *  - **Filling in `TelegramConsole`.** Eight members, four of which
 *    `ServerRuntime` already answers. The channel states the port; this
 *    satisfies it.
 *
 * The factory is registered **only when a token resolves**, so an install that
 * has never configured Telegram starts exactly as it did before this existed.
 */

import { existsSync } from 'node:fs';

import { telegramChannel, type TelegramConsole } from '@ghostai/channels';
import type {
  ChannelFactory,
  MemoryState,
  TelegramChannel,
} from '@ghostai/channels';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_WORKSPACE_ID,
  readMemories,
  type GhostPaths,
  type Logger,
  type SessionRecord,
} from '@ghostai/core';
import type { ChannelStatus, ContextResponse } from '@ghostai/protocol';
import { estimateTokens } from '@ghostai/providers';
import {
  openVault,
  type EffectiveAgent,
  type GhostRuntime,
} from '@ghostai/runtime';
import { buildContextResponse, type ServerRuntime } from '@ghostai/server';

/** The vault namespace a channel's credentials live under. */
export const CHANNEL_CREDENTIAL_NAMESPACE = 'channels';

/** The environment variable consulted when the vault holds no token. */
export const TELEGRAM_TOKEN_ENV_VAR = 'TELEGRAM_BOT_TOKEN';

export interface ResolveTokenOptions {
  readonly paths: GhostPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `config.channels.telegram`, unparsed. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly logger?: Logger;
}

/**
 * The bot token, from the first place that has one.
 *
 * The vault is opened only when one already exists on disk — the same condition
 * `findCredential` applies, and for the same reason: `resolveVaultKey` writes a
 * key to the OS keychain the first time it runs, and an install that never
 * stores a credential should not acquire a keychain entry just by booting.
 */
export function resolveTelegramToken(
  options: ResolveTokenOptions,
): string | undefined {
  if (existsSync(options.paths.vaultFile)) {
    const stored = openVault(options.paths).get(
      CHANNEL_CREDENTIAL_NAMESPACE,
      'telegram',
    );
    if (stored !== undefined && stored !== '') return stored;
  }

  const fromEnv = options.env[TELEGRAM_TOKEN_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const fromConfig = options.settings.token;
  if (typeof fromConfig === 'string' && fromConfig !== '') {
    // Said out loud once at startup rather than left to be discovered: a bot
    // token is a credential, and `config.json` is a plain file that backups,
    // dotfile repositories and screen shares all reach.
    options.logger?.warn(
      { channel: 'telegram' },
      'the Telegram bot token is in config.json as plain text; ' +
        'move it to the credential vault under channels/telegram',
    );
    return fromConfig;
  }
  return undefined;
}

/**
 * `TelegramConsole` over the running install.
 *
 * The two stores are handed over concretely, exactly as `ServerRuntime` hands
 * them to the routes: the port is narrow about *behaviour* — what a chat may
 * reach — not about types.
 */
export function createTelegramConsole(
  runtime: GhostRuntime,
  server: ServerRuntime,
): TelegramConsole {
  return {
    store: runtime.store,
    workspaces: runtime.workspaces,
    agents: () => server.agents(),
    models: async () =>
      // `models` is optional on the port `@ghostai/server` states, because a
      // route test standing in for a runtime has no provider to ask. The real
      // adapter always has one.
      (await server.models?.()) ?? { models: [], errors: {} },
    setModel: (id) => {
      // `reconfigure`, not `applySettings`: this is what the terminal's
      // `/model` does — it moves the process without rewriting `config.json`,
      // so a restart returns to whatever the operator actually configured.
      runtime.reconfigure({ agents: { defaults: { model: id } } });
    },
    context: async (sessionKey): Promise<ContextResponse | undefined> =>
      await buildContextResponse(server, sessionKey),

    memory: async (sessionKey): Promise<MemoryState> => {
      const { agent, session } = memoryTargets(runtime, sessionKey);
      const permission = agent?.tools.memory;
      const granted = permission !== undefined && permission !== 'deny';

      const memories = granted
        ? await readMemories(
            runtime.jails.forWorkspace(
              session?.workspaceId ?? DEFAULT_WORKSPACE_ID,
            ).root,
          )
        : [];

      return {
        granted,
        count: memories.length,
        // What the *index* costs, which is what reaches the prompt. The bodies
        // are on disk until something opens one.
        tokens: estimateTokens(
          memories.map((memory) => memory.description).join('\n'),
        ),
      };
    },
  };
}

/**
 * The agent and session a `/memory` call is about.
 *
 * Read together because both come from the stored row rather than the incoming
 * message — a chat is bound to a conversation, and the conversation names the
 * agent.
 */
function memoryTargets(
  runtime: GhostRuntime,
  sessionKey: string,
): {
  readonly agent: EffectiveAgent | undefined;
  readonly session: SessionRecord | undefined;
} {
  const session = runtime.store.getSession(sessionKey);
  const agentId = session?.agentId ?? DEFAULT_AGENT_ID;
  return {
    agent: runtime.agents.find((entry) => entry.id === agentId),
    session,
  };
}

/** `config.channels.telegram`, narrowed. Unknown to the type, loose by design. */
export function telegramSettingsOf(
  runtime: GhostRuntime,
): Readonly<Record<string, unknown>> {
  const block = runtime.config.channels.telegram;
  return typeof block === 'object' && block !== null && !Array.isArray(block)
    ? (block as Readonly<Record<string, unknown>>)
    : {};
}

export interface TelegramStatusOptions {
  readonly runtime: GhostRuntime;
  readonly paths: GhostPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The channel, when one is running. */
  readonly channel: TelegramChannel | undefined;
  /** Why the last start failed, when it did. */
  readonly startError?: string | undefined;
}

/**
 * What the settings panel shows for Telegram.
 *
 * Four separate answers, because "is my bot working" has four and the operator
 * has to act on a different one in each case. `configured` is a boolean and
 * never the token: the vault is write-only over HTTP, so this is the only way
 * the panel can say a token is saved rather than showing an empty box over a
 * bot that is running perfectly well.
 */
export function telegramStatus(options: TelegramStatusOptions): ChannelStatus {
  const settings = telegramSettingsOf(options.runtime);
  const token = resolveTelegramToken({
    paths: options.paths,
    env: options.env,
    settings,
  });
  const running = options.channel !== undefined;
  const username = options.channel?.username;

  return {
    id: 'telegram',
    // Absent means enabled: `ChannelManager` only skips a channel whose block
    // says `enabled: false`, so the panel has to read the same default.
    enabled: settings.enabled !== false,
    configured: token !== undefined,
    running,
    ...detailOf({
      running,
      ...(username === undefined ? {} : { username }),
      ...(options.startError === undefined
        ? {}
        : { startError: options.startError }),
    }),
  };
}

function detailOf(input: {
  running: boolean;
  username?: string;
  startError?: string;
}): { detail?: string } {
  if (input.running) {
    return input.username === undefined ? {} : { detail: `@${input.username}` };
  }
  return input.startError === undefined ? {} : { detail: input.startError };
}

export interface TelegramFactoriesOptions {
  readonly runtime: GhostRuntime;
  readonly server: ServerRuntime;
  readonly paths: GhostPaths;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
}

/**
 * The Telegram factory, or nothing.
 *
 * Nothing is the normal case, and it has to stay cheap: `ghost serve` must come
 * up unchanged on the overwhelming majority of installs that have never heard
 * of a bot. A token that *does* resolve but is refused by the API is a
 * different matter — that fails startup, which is what `channel.ts` documents.
 */
export function telegramFactories(
  options: TelegramFactoriesOptions,
): readonly ChannelFactory[] {
  const settings = telegramSettingsOf(options.runtime);
  const token = resolveTelegramToken({
    paths: options.paths,
    env: options.env,
    settings,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  if (token === undefined) return [];

  return [
    telegramChannel({
      token,
      console: createTelegramConsole(options.runtime, options.server),
    }),
  ];
}
