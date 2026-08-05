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
 *  - **Filling in `TelegramConsole`.** Six members, four of which
 *    `ServerRuntime` already answers. The channel states the port; this
 *    satisfies it.
 *
 * The factory is registered **only when a token resolves**, so an install that
 * has never configured Telegram starts exactly as it did before this existed.
 */

import { existsSync } from 'node:fs';

import { telegramChannel, type TelegramConsole } from '@ghostai/channels';
import type { ChannelFactory } from '@ghostai/channels';
import type { GhostPaths, Logger } from '@ghostai/core';
import type { ContextResponse } from '@ghostai/protocol';
import { openVault, type GhostRuntime } from '@ghostai/runtime';
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
  };
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
  const block = options.runtime.config.channels.telegram;
  const settings =
    typeof block === 'object' && block !== null && !Array.isArray(block)
      ? (block as Readonly<Record<string, unknown>>)
      : {};

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
