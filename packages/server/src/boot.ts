/**
 * The question asked before a socket is opened.
 *
 * It is a refusal rather than a warning, and that distinction is the whole
 * point of this module. A warning about an unauthenticated bind scrolls past in
 * a terminal that nobody is watching, and what survives it is a shell-capable
 * agent answering to anyone who can route a packet to the host. A process that
 * will not start is impossible to miss and impossible to ignore.
 *
 * There used to be a second refusal — auth enabled with no password set — and
 * removing it is the point of the setup code. It was there because starting
 * anyway produced a server whose login could never succeed and whose every
 * route answered 401, which reads as a bug in the UI rather than as unfinished
 * setup. But it also meant the one interface that could set a password was the
 * one thing an install without a password could not reach, so the only cure for
 * a fresh machine was to hand-write a config or pass `--password` to a command
 * nobody had been told about. `AuthStore.issueSetupCode()` closes that loop:
 * the server starts, prints a single-use code to the terminal the operator is
 * already looking at, and refuses everything else until it is spent.
 */

import { GhostError } from '@ghostwire/core';
import { isLoopbackHost, type Config } from '@ghostwire/protocol';

interface BootPolicyInput {
  readonly config: Config;
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
}
