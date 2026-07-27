/**
 * The two questions asked before a socket is opened.
 *
 * Both are refusals rather than warnings, and that distinction is the whole
 * point of this module. A warning about an unauthenticated bind scrolls past in
 * a terminal that nobody is watching, and what survives it is a shell-capable
 * agent answering to anyone who can route a packet to the host. A process that
 * will not start is impossible to miss and impossible to ignore.
 *
 * The second refusal — auth enabled with no password set — exists for the
 * opposite failure. Starting anyway would produce a server whose login can
 * never succeed and whose every route answers 401, which reads as a bug in the
 * UI rather than as unfinished setup.
 */

import { GhostError } from '@ghostai/core';
import { isLoopbackHost, type Config } from '@ghostai/protocol';

export interface BootPolicyInput {
  readonly config: Config;
  /** Whether a password hash exists to check a login against. */
  readonly hasPassword: boolean;
}

/**
 * Throws a `config` error if this configuration must not be served.
 *
 * Called before the Fastify instance is built, so a refusal costs nothing and
 * leaves nothing to tear down.
 */
export function assertBootPolicy(input: BootPolicyInput): void {
  const { host, port, auth } = input.config.server;

  if (!auth.enabled && !isLoopbackHost(host)) {
    throw new GhostError(
      'config',
      `Refusing to start: server.host is "${host}" and server.auth.enabled is false.\n` +
        `  Binding beyond loopback without authentication exposes an agent that can\n` +
        `  read files and run commands to anyone who can reach ${host}:${String(port)}.\n` +
        '  Set server.auth.enabled to true, or bind to 127.0.0.1.',
      { details: { host, port } },
    );
  }

  if (auth.enabled && !input.hasPassword) {
    throw new GhostError(
      'config',
      'Refusing to start: authentication is enabled and no password has been set.\n' +
        '  Every request would be rejected and no login could ever succeed.\n' +
        '  Start with --password, set GHOSTAI_PASSWORD, or disable server.auth.enabled\n' +
        '  on a loopback bind.',
    );
  }
}
