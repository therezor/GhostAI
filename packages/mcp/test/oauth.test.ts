import { McpOAuthConfigSchema } from '@ghostwire/protocol';
import { describe, expect, it } from 'vitest';

import { VaultOAuthProvider } from '#src/oauth.js';
import { memorySecretStore, type McpSecretStore } from '#src/store.js';

const CONFIG = McpOAuthConfigSchema.parse({
  authUrl: 'https://auth.test/authorize',
  tokenUrl: 'https://auth.test/token',
  clientId: 'configured-id',
  scopes: ['read', 'write'],
});

function provider(
  store: McpSecretStore = memorySecretStore(),
  onAuthorizationRequired: (url: string) => void = () => undefined,
) {
  return {
    store,
    provider: new VaultOAuthProvider({
      serverId: 'github',
      config: CONFIG,
      store,
      redirectUrl: 'http://127.0.0.1:33418/mcp/callback',
      state: 'abc123',
      onAuthorizationRequired,
    }),
  };
}

describe('VaultOAuthProvider', () => {
  it('describes GhostAI as a public client using PKCE', () => {
    // Nowhere to keep a client secret the operator cannot already read, which
    // is what `token_endpoint_auth_method: none` says out loud.
    const { provider: subject } = provider();
    expect(subject.clientMetadata).toMatchObject({
      client_name: 'GhostAI',
      redirect_uris: ['http://127.0.0.1:33418/mcp/callback'],
      token_endpoint_auth_method: 'none',
      scope: 'read write',
    });
  });

  it('omits the scope entirely when none is configured', () => {
    const bare = new VaultOAuthProvider({
      serverId: 'github',
      config: McpOAuthConfigSchema.parse({
        authUrl: 'https://auth.test/a',
        tokenUrl: 'https://auth.test/t',
        clientId: 'x',
      }),
      store: memorySecretStore(),
      redirectUrl: 'http://127.0.0.1:1/mcp/callback',
      state: 's',
      onAuthorizationRequired: () => undefined,
    });
    expect(bare.clientMetadata).not.toHaveProperty('scope');
  });

  it('routes a redirect back with the state it was given', () => {
    const { provider: subject } = provider();
    expect(subject.state()).toBe('abc123');
    expect(subject.redirectUrl).toBe('http://127.0.0.1:33418/mcp/callback');
  });

  it('falls back to the configured client id until one is registered', () => {
    const { provider: subject, store } = provider();
    expect(subject.clientInformation()).toEqual({ client_id: 'configured-id' });

    subject.saveClientInformation({ client_id: 'issued-id' });
    // Dynamic registration wins: that is the identity the server knows us by.
    expect(subject.clientInformation()).toEqual({ client_id: 'issued-id' });
    expect(store.read('github', 'client')).toContain('issued-id');
  });

  it('has no client information when nothing is configured or registered', () => {
    const bare = new VaultOAuthProvider({
      serverId: 'github',
      config: McpOAuthConfigSchema.parse({
        authUrl: 'https://auth.test/a',
        tokenUrl: 'https://auth.test/t',
        clientId: 'x',
      }),
      store: memorySecretStore(),
      redirectUrl: 'http://127.0.0.1:1/mcp/callback',
      state: 's',
      onAuthorizationRequired: () => undefined,
    });
    // `clientId` is `.min(1)` in the schema, so "absent" is the registered
    // case having been cleared; the store is what answers.
    expect(bare.clientInformation()).toEqual({ client_id: 'x' });
  });

  it('round-trips tokens through the store', () => {
    const { provider: subject, store } = provider();
    expect(subject.tokens()).toBeUndefined();

    subject.saveTokens({ access_token: 'at', token_type: 'bearer' });
    expect(subject.tokens()).toEqual({
      access_token: 'at',
      token_type: 'bearer',
    });
    // In the vault, never in `config.json`: this is a credential this process
    // obtained rather than a setting somebody typed.
    expect(store.read('github', 'tokens')).toContain('at');
  });

  it('treats an unreadable stored value as absent, so the flow can restart', () => {
    const store = memorySecretStore();
    store.write('github', 'tokens', 'not json');
    const { provider: subject } = provider(store);
    expect(subject.tokens()).toBeUndefined();
  });

  it('keeps the PKCE verifier in memory only', () => {
    const { provider: subject, store } = provider();
    expect(() => subject.codeVerifier()).toThrow(/No PKCE verifier/);

    subject.saveCodeVerifier('verifier');
    expect(subject.codeVerifier()).toBe('verifier');
    // Valid for one exchange, over in seconds. Persisting it would leave a
    // credential on disk with no remaining purpose.
    expect(store.read('github', 'tokens')).toBeUndefined();
    expect(store.read('github', 'client')).toBeUndefined();
  });

  it('hands the authorization url over instead of opening anything', () => {
    const seen: string[] = [];
    const { provider: subject } = provider(memorySecretStore(), (url) => {
      seen.push(url);
    });
    subject.redirectToAuthorization(new URL('https://auth.test/authorize?x=1'));
    // A headless server that shells out to `open` fails where nobody can see.
    expect(seen).toEqual(['https://auth.test/authorize?x=1']);
  });

  it('clears exactly the credentials it is told are no longer good', () => {
    const { provider: subject, store } = provider();
    subject.saveTokens({ access_token: 'at', token_type: 'bearer' });
    subject.saveClientInformation({ client_id: 'issued' });
    subject.saveCodeVerifier('verifier');

    subject.invalidateCredentials('tokens');
    expect(store.read('github', 'tokens')).toBeUndefined();
    expect(store.read('github', 'client')).toBeDefined();

    subject.invalidateCredentials('verifier');
    expect(() => subject.codeVerifier()).toThrow();

    subject.invalidateCredentials('all');
    expect(store.read('github', 'client')).toBeUndefined();
  });
});

describe('memorySecretStore', () => {
  it('clears every slot for one server when asked for none in particular', () => {
    const store = memorySecretStore();
    store.write('a', 'tokens', '1');
    store.write('a', 'client', '2');
    store.write('b', 'tokens', '3');

    store.clear('a');
    expect(store.read('a', 'tokens')).toBeUndefined();
    expect(store.read('a', 'client')).toBeUndefined();
    expect(store.read('b', 'tokens')).toBe('3');
  });
});
