/**
 * One `tools.mcpServers.<id>` entry, resolved into something connectable.
 *
 * The config schema is deliberately permissive — every field has a default, and
 * `type` is optional because the shape of the entry already implies it. This is
 * where that permissiveness is turned into a decision, once, so that nothing
 * downstream has to ask "is this a stdio server?" by looking at whether
 * `command` happens to be empty.
 *
 * Two rules are worth stating because they are choices rather than derivations:
 *
 *  - **`sse` is never inferred.** The SDK marks that transport deprecated and
 *    Streamable HTTP serves the same URL shape, so an entry with a `url` and no
 *    `type` gets the transport it almost certainly wants. Reaching the legacy
 *    one is an explicit `"type": "sse"`.
 *  - **A URL is checked, not guarded.** See `assertUsableUrl`.
 */

import { GhostError } from '@ghostbot/core';
import type { McpOAuthConfig, McpServerConfig } from '@ghostbot/protocol';

/** What `StdioClientTransport` needs, with nothing left to infer. */
interface McpStdioSpec {
  readonly kind: 'stdio';
  readonly serverId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly toolTimeoutMs: number;
  readonly enabledTools: readonly string[];
}

/** What either HTTP transport needs. */
interface McpHttpSpec {
  readonly kind: 'streamableHttp' | 'sse';
  readonly serverId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly oauth: McpOAuthConfig | undefined;
  readonly toolTimeoutMs: number;
  readonly enabledTools: readonly string[];
}

export type McpConnectionSpec = McpStdioSpec | McpHttpSpec;

type SpecResolution =
  | { readonly ok: true; readonly spec: McpConnectionSpec }
  | { readonly ok: false; readonly error: GhostError };

function refuse(
  serverId: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): SpecResolution {
  return {
    ok: false,
    error: new GhostError('config', `MCP server "${serverId}": ${message}`, {
      details: { server: serverId, ...details },
    }),
  };
}

/**
 * Whether a URL is one this client will dial.
 *
 * **Deliberately not `validateTarget`.** That guard exists to stop *the model*
 * choosing a destination, and the single most common MCP deployment is a server
 * on loopback — the one address it is built to refuse. An MCP `url` is operator
 * configuration in `config.json`, in the same trust class as
 * `providers.<id>.apiBase`, and it is checked the same way that is: a scheme
 * this client speaks, and a URL that parses.
 *
 * The OAuth endpoints are the exception, and they are guarded — see `oauth.ts`.
 * Discovery can move the token exchange to a host the operator never typed, and
 * what is being handed to it is a credential.
 */
function parseUrl(serverId: string, url: string): URL | SpecResolution {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse(serverId, `"${url}" is not a URL`, { url });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refuse(
      serverId,
      `only http and https URLs are supported, not "${parsed.protocol}"`,
      { url },
    );
  }
  return parsed;
}

/**
 * The transport an entry names, or the one its shape implies.
 *
 * An explicit `type` is still cross-checked against the fields it needs, so
 * `{"type": "stdio"}` with no `command` fails here rather than as an
 * unexplained spawn error a minute later.
 */
export function resolveSpec(
  serverId: string,
  config: McpServerConfig,
): SpecResolution {
  const command = config.command.trim();
  const url = config.url.trim();
  const shared = {
    serverId,
    toolTimeoutMs: config.toolTimeoutMs,
    enabledTools: config.enabledTools,
  };

  const kind =
    config.type ??
    (command !== '' ? 'stdio' : url !== '' ? 'streamableHttp' : undefined);

  if (kind === undefined) {
    return refuse(serverId, 'names neither a command nor a url');
  }
  if (command !== '' && url !== '') {
    return refuse(
      serverId,
      'names both a command and a url; a server is one or the other',
    );
  }

  if (kind === 'stdio') {
    if (command === '') {
      return refuse(serverId, 'is a stdio server with no command');
    }
    return {
      ok: true,
      spec: {
        kind: 'stdio',
        ...shared,
        command,
        args: config.args,
        env: config.env,
      },
    };
  }

  if (url === '') {
    return refuse(serverId, `is a ${kind} server with no url`);
  }
  const parsed = parseUrl(serverId, url);
  if (!(parsed instanceof URL)) return parsed;

  return {
    ok: true,
    spec: {
      kind,
      ...shared,
      url: parsed.toString(),
      headers: config.headers,
      oauth: config.oauth,
    },
  };
}

/**
 * Everything that decides *which process or endpoint* this is.
 *
 * Changing any of it has to bounce the connection. Kept apart from
 * `exposureFingerprint` so that narrowing `enabledTools` — the edit an operator
 * makes most — does not kill and respawn a subprocess to re-filter a list this
 * client already holds.
 */
export function transportFingerprint(spec: McpConnectionSpec): string {
  return JSON.stringify(
    spec.kind === 'stdio'
      ? [spec.kind, spec.command, spec.args, spec.env]
      : [spec.kind, spec.url, spec.headers, spec.oauth ?? null],
  );
}

/** Everything that decides which of a live server's tools reach the registry. */
export function exposureFingerprint(spec: McpConnectionSpec): string {
  return JSON.stringify([spec.enabledTools, spec.toolTimeoutMs]);
}
