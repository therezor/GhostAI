/**
 * `OAuthClientProvider`, backed by the credential vault.
 *
 * The SDK owns the protocol — discovery, PKCE, the code exchange, refresh — and
 * asks an application for exactly two things: somewhere to put what it minted,
 * and somewhere to send the operator. This module answers both.
 *
 * **Type-only import of the SDK, deliberately.** The rule for this package is
 * that `sdk-connector.ts` is the one module that loads
 * `@modelcontextprotocol/sdk` at runtime, so that a test never reaches a real
 * transport. `import type` erases entirely — no module is loaded — while still
 * making the compiler check that what is written here is what the SDK will
 * call. A structural duck-type would have neither property.
 *
 * Three decisions about storage, each with a different answer:
 *
 *  - **Tokens and dynamic client registration go to the vault.** They are
 *    long-lived credentials this process obtained, not settings a person typed,
 *    which is precisely the line `CredentialVault` exists to hold.
 *  - **The PKCE verifier is memory-only.** It is valid for one exchange, over
 *    in seconds; persisting it would leave a credential on disk with no
 *    remaining purpose, and it is meaningless across a restart anyway.
 *  - **Nothing opens a browser.** `redirectToAuthorization` hands the URL to
 *    the manager, which puts the server in `needs_authorization` with a link on
 *    it. A headless server that shells out to `open` is a headless server that
 *    fails in a way nobody can see.
 */

import { GhostError } from '@ghostai/core';
import type { McpOAuthConfig } from '@ghostai/protocol';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

import type { McpSecretStore } from './store.js';

/** How GhostAI describes itself to an authorization server. */
export const OAUTH_CLIENT_NAME = 'GhostAI';

export interface OAuthProviderOptions {
  readonly serverId: string;
  readonly config: McpOAuthConfig;
  readonly store: McpSecretStore;
  /** The loopback callback, from `CallbackListener`. */
  readonly redirectUrl: string;
  /** The `state` minted for this attempt, so the callback can route it. */
  readonly state: string;
  /** Called with the URL the operator has to visit. Never opens anything. */
  readonly onAuthorizationRequired: (url: string) => void;
}

function readJson(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A vault entry that does not parse is a credential from an older shape or
    // a corrupted write. Treating it as absent restarts the flow, which is
    // recoverable; throwing here would wedge the server permanently.
    return undefined;
  }
}

/**
 * One server's OAuth session.
 *
 * A class rather than a closure because the interface is fourteen members and
 * three of them are getters — the shape the SDK checks is easier to read, and
 * to keep in step, written out.
 */
export class VaultOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;

  constructor(private readonly options: OAuthProviderOptions) {}

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.options.config.scopes.join(' ');
    return {
      client_name: OAUTH_CLIENT_NAME,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A public client: GhostAI runs on the operator's own machine and has
      // nowhere to keep a client secret that the operator cannot already read.
      // PKCE is what stands in for one, which is what it is for.
      token_endpoint_auth_method: 'none',
      ...(scope === '' ? {} : { scope }),
    };
  }

  state(): string {
    return this.options.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // Dynamic registration wins over the configured id: if the server issued us
    // one, that is the identity it knows us by. A `clientId` in `config.json`
    // is the pre-registered case, and the fallback for a server that does not
    // support registration at all.
    const registered = readJson(
      this.options.store.read(this.options.serverId, 'client'),
    ) as OAuthClientInformationMixed | undefined;
    if (registered !== undefined) return registered;
    const configured = this.options.config.clientId;
    return configured === '' ? undefined : { client_id: configured };
  }

  saveClientInformation(information: OAuthClientInformationMixed): void {
    this.options.store.write(
      this.options.serverId,
      'client',
      JSON.stringify(information),
    );
  }

  tokens(): OAuthTokens | undefined {
    return readJson(
      this.options.store.read(this.options.serverId, 'tokens'),
    ) as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.options.store.write(
      this.options.serverId,
      'tokens',
      JSON.stringify(tokens),
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.options.onAuthorizationRequired(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (this.verifier === undefined) {
      throw new GhostError(
        'conflict',
        `No PKCE verifier is outstanding for MCP server "${this.options.serverId}"`,
      );
    }
    return this.verifier;
  }

  /**
   * The server told us a credential is no longer good.
   *
   * Acting on it is what stops an expired refresh token from being retried
   * forever; without this the operator has to delete the server and add it
   * back to recover.
   */
  invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): void {
    if (scope === 'verifier' || scope === 'discovery') {
      this.verifier = undefined;
      return;
    }
    if (scope === 'all') {
      this.verifier = undefined;
      this.options.store.clear(this.options.serverId);
      return;
    }
    this.options.store.clear(this.options.serverId, scope);
  }
}
