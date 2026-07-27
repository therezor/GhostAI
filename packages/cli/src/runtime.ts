/**
 * The composition root.
 *
 * Every package below this one takes its collaborators as constructor options
 * and constructs none of them; this is the single place where a config file
 * becomes a provider, a jail, a store, a registry and a loop. That is what keeps
 * the rest of the repo testable without a filesystem — and it is why this file
 * is the only one in the package that touches the vault, the database or the
 * keychain.
 *
 * The decisions here that are not obvious:
 *
 *  - **Provider resolution is `@ghostai/providers`' order, not a second one.**
 *    `resolveProvider` runs explicit id → gateway/local detection → model name,
 *    and returns `null` rather than guessing. The CLI adds exactly one step
 *    after that null: a provider whose `envKey` is set in the environment. An
 *    exported credential is an operator saying which provider they mean, and
 *    `OPENAI_API_KEY=… ghost chat` should not need a config file to work. What
 *    it will not do is fall back to *some* provider, because a request landing
 *    at an endpoint nobody chose fails as a 401 from somewhere unexpected.
 *
 *  - **The vault is opened lazily, and often not at all.** `resolveVaultKey`
 *    writes a key to the OS keychain the first time it runs. Doing that on every
 *    `ghost chat` against a local Ollama — which needs no credential at all — is
 *    a keychain entry created for nothing, so a local provider with no `envKey`
 *    skips the vault entirely.
 *
 *  - **The vault wins over the environment.** `spec.envKey` is documented as the
 *    variable consulted when the vault holds no key; an exported variable in a
 *    shell must not silently override the credential the operator stored.
 *
 *  - **`close()` exists because `SessionStore` owns its connection.** The store
 *    opened here is not a borrowed one, so nothing else will close it, and a CLI
 *    that leaves SQLite's WAL unfinalised leaves a `-wal` file beside the
 *    database for the next process to recover.
 */

import { AgentLoop } from '@ghostai/agent';
import {
  GhostError,
  SessionStore,
  loadConfig,
  silentLogger,
  type GhostPaths,
  type Logger,
} from '@ghostai/core';
import type { AgentDefaults, Config } from '@ghostai/protocol';
import {
  PROVIDERS,
  createProvider,
  resolveConnection,
  resolveProvider,
  type ProviderSpec,
} from '@ghostai/providers';
import {
  CredentialVault,
  WorkspaceJail,
  keyFileStore,
  keychainStore,
  resolveVaultKey,
  type FetchImplementation,
} from '@ghostai/security';
import { ToolRegistry, registerBuiltins } from '@ghostai/tools';

/** The vault namespace provider API keys live under. */
export const PROVIDER_CREDENTIAL_NAMESPACE = 'providers';

export interface RuntimeOptions {
  /** `GHOSTAI_HOME` override. */
  readonly home?: string | undefined;
  /** Wins over `agents.defaults.workspace`. */
  readonly workspace?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  /** `false` starts the loop with no tools at all. */
  readonly tools?: boolean;
  readonly logger?: Logger;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected by tests so nothing here opens a socket. */
  readonly fetchImpl?: FetchImplementation | undefined;
  /** `false` skips the credential vault; a value replaces it. */
  readonly vault?: CredentialVault | false | undefined;
}

export interface ChatRuntime {
  readonly loop: AgentLoop;
  readonly store: SessionStore;
  readonly config: Config;
  readonly paths: GhostPaths;
  readonly spec: ProviderSpec;
  readonly model: string;
  /** Whether a credential was found, without saying what it was. */
  readonly hasCredential: boolean;
  close(): void;
}

/**
 * A provider whose `envKey` is exported, used only after `resolveProvider`
 * returns `null`. Table order decides ties, which puts gateways first — the
 * same precedence `findGateway` applies.
 */
function providerFromEnv(env: Readonly<Record<string, string | undefined>>): ProviderSpec | null {
  for (const spec of PROVIDERS) {
    const key = spec.envKey;
    if (key !== undefined && (env[key] ?? '') !== '') return spec;
  }
  return null;
}

function noProviderError(configFile: string): GhostError {
  const ids = PROVIDERS.map((spec) => spec.id).join(', ');
  return new GhostError(
    'config',
    'No provider could be resolved.\n' +
      "  Pass --provider <id> --model <model>, export the provider's API key variable,\n" +
      `  or set agents.defaults in ${configFile}.\n` +
      `  Known providers: ${ids}`,
  );
}

function openVault(paths: GhostPaths): CredentialVault {
  const resolved = resolveVaultKey({
    stores: [keychainStore(), keyFileStore({ file: paths.keyFile })],
  });
  return new CredentialVault({ file: paths.vaultFile, key: resolved.key });
}

/**
 * The credential for one provider: vault first, environment second.
 *
 * Returns `undefined` rather than throwing when there is none — a local model
 * server needs no key, and `createProvider` is what refuses a remote endpoint
 * that does. Vault failures are not swallowed: a vault that will not open means
 * the wrong key or a modified file, and quietly continuing without it would
 * reach the provider as an unexplained 401.
 *
 * Exported because precedence between two credential sources is the kind of
 * rule that is worth asserting directly, rather than inferring from a request
 * header three layers away.
 */
export function findCredential(
  spec: ProviderSpec,
  paths: GhostPaths,
  env: Readonly<Record<string, string | undefined>>,
  vault: CredentialVault | false | undefined,
): string | undefined {
  const fromEnv = spec.envKey === undefined ? undefined : env[spec.envKey];
  const needsKey = spec.isLocal !== true || spec.envKey !== undefined;
  if (!needsKey || vault === false) return fromEnv === '' ? undefined : fromEnv;

  const opened = vault ?? openVault(paths);
  const stored = opened.get(PROVIDER_CREDENTIAL_NAMESPACE, spec.id);
  if (stored !== undefined && stored !== '') return stored;
  return fromEnv === '' ? undefined : fromEnv;
}

export function createChatRuntime(options: RuntimeOptions = {}): ChatRuntime {
  const env = options.env ?? process.env;
  const logger = options.logger ?? silentLogger;

  const loaded = loadConfig({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    env,
  });
  const { config, paths } = loaded;

  const defaults: AgentDefaults = config.agents.defaults;
  const model = options.model ?? defaults.model;
  const providerId = options.provider ?? defaults.provider;

  const spec = resolveProvider({ provider: providerId, model }) ?? providerFromEnv(env);
  if (spec === null) throw noProviderError(loaded.file);

  if (model === '') {
    throw new GhostError(
      'config',
      `No model configured for ${spec.displayName}.\n` +
        `  Pass --model <model>, or set agents.defaults.model in ${loaded.file}.`,
    );
  }

  const connection = resolveConnection(spec, config.providers[spec.id]);
  const apiKey = findCredential(spec, paths, env, options.vault);

  const provider = createProvider({
    provider: spec,
    apiKey,
    apiBase: connection.apiBase,
    extraHeaders: connection.extraHeaders,
    fetchImpl: options.fetchImpl,
  });

  const jail = new WorkspaceJail({ root: paths.workspace });
  const store = new SessionStore({ file: paths.dbFile });
  const tools = new ToolRegistry({ timeoutMs: defaults.toolTimeoutMs, logger });
  if (options.tools !== false) registerBuiltins(tools, config.tools);

  const loop = new AgentLoop({
    provider,
    tools,
    store,
    jail,
    config: defaults,
    toolsConfig: config.tools,
    model,
    logger,
    env,
  });

  return {
    loop,
    store,
    config,
    paths,
    spec,
    model,
    hasCredential: apiKey !== undefined,
    close: () => {
      store.close();
    },
  };
}
