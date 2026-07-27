import { ConfigSchema, type Config } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { assertBootPolicy } from './boot.js';

function config(server: Record<string, unknown>): Config {
  return ConfigSchema.parse({ server });
}

describe('assertBootPolicy', () => {
  it('allows the default: loopback with authentication on', () => {
    expect(() => {
      assertBootPolicy({ config: config({}), hasPassword: true });
    }).not.toThrow();
  });

  it('allows authentication off on loopback', () => {
    expect(() => {
      assertBootPolicy({
        config: config({ host: '127.0.0.1', auth: { enabled: false } }),
        hasPassword: false,
      });
    }).not.toThrow();
  });

  // The single most important line in the package. A warning here scrolls past
  // and leaves a shell-capable agent answering to the whole network.
  it.each(['0.0.0.0', '::', '192.168.1.10', 'ghost.local', '[::]'])(
    'refuses to serve %s without authentication',
    (host) => {
      expect(() => {
        assertBootPolicy({
          config: config({ host, auth: { enabled: false } }),
          hasPassword: false,
        });
      }).toThrow(/Refusing to start/);
    },
  );

  it('names the host and port it refused, and what to change', () => {
    let message = '';
    try {
      assertBootPolicy({
        config: config({ host: '0.0.0.0', port: 8080, auth: { enabled: false } }),
        hasPassword: false,
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('0.0.0.0');
    expect(message).toContain('8080');
    expect(message).toContain('server.auth.enabled');
  });

  it.each(['127.0.0.1', '127.0.0.99', 'localhost', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(() => {
        assertBootPolicy({
          config: config({ host, auth: { enabled: false } }),
          hasPassword: false,
        });
      }).not.toThrow();
    },
  );

  // Starting anyway produces a server whose login can never succeed and whose
  // every route answers 401, which reads as a broken UI rather than as setup
  // that was never finished.
  it('refuses to start with authentication on and no password set', () => {
    expect(() => {
      assertBootPolicy({ config: config({}), hasPassword: false });
    }).toThrow(/no password has been set/);
  });

  it('carries the host and port as structured detail, not only in the message', () => {
    try {
      assertBootPolicy({
        config: config({ host: '0.0.0.0', port: 8080, auth: { enabled: false } }),
        hasPassword: false,
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as { details: Record<string, unknown> }).details).toEqual({
        host: '0.0.0.0',
        port: 8080,
      });
      expect((error as { kind: string }).kind).toBe('config');
    }
  });
});
