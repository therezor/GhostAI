/**
 * Egress with the DNS rebinding window closed.
 *
 * The usual shape of an SSRF guard — resolve the hostname, check the addresses,
 * then hand the *URL* to an HTTP client — is advisory only. The client performs
 * its own lookup when it connects, and nothing obliges the second answer to
 * match the first. A DNS server that alternates between a public address and
 * 169.254.169.254 passes validation on every attempt and connects to the
 * metadata endpoint on roughly half of them. The check and the connection have
 * to share one resolution or the check is decoration.
 *
 * So validation resolves the host itself and the resulting addresses are pinned
 * into the dispatcher: `Agent({ connect: { lookup } })` with a `lookup` that
 * returns the already-validated addresses and never consults DNS. There is no
 * second resolution to differ from the first.
 *
 * The rest follows from taking redirects seriously. Every hop is validated
 * again, with a fresh pin, because a public URL that 302s to
 * `http://169.254.169.254/` is the same attack with one more step.
 * `Authorization` and `Cookie` are dropped when the origin changes, so a
 * redirect cannot turn a credential into an exfiltration channel. And the
 * response body is capped as it streams rather than after it arrives, because
 * "the model asked for a URL that serves an endless stream" must not be a way to
 * exhaust the host's memory.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';

import {
  Agent,
  type RequestInit,
  Response,
  fetch as undiciFetch,
} from 'undici';

import { GhostError } from '@ghostai/core';

import {
  type AddressRange,
  type IpFamily,
  classifyAddress,
  parseIpLiteral,
} from './ip.js';

export interface PinnedAddress {
  readonly address: string;
  readonly family: IpFamily;
}

export type DnsResolver = (
  hostname: string,
) => Promise<readonly PinnedAddress[]>;

export interface NetworkPolicy {
  /** Permit 127.0.0.0/8 and `::1`. Needed to reach a model server on this host. */
  readonly allowLoopback?: boolean;
  /** Permit RFC 1918 and unique-local ranges. For a LAN deployment. */
  readonly allowPrivate?: boolean;
  /**
   * Hosts exempt from address classification entirely. Exact match, or a
   * leading-dot entry (`.internal`) to cover subdomains.
   *
   * This is the operator saying "I know what is there" — a self-hosted
   * inference server, an internal MCP endpoint. It is not reachable from
   * anything a model controls, because a model cannot edit config.
   */
  readonly allowedHosts?: readonly string[];
  /** Refused before anything else, including entries in `allowedHosts`. */
  readonly deniedHosts?: readonly string[];
  readonly maxRedirects?: number;
  /** `0` disables the cap. */
  readonly maxBytes?: number;
  /** `0` disables the timeout. */
  readonly timeoutMs?: number;
}

export const DEFAULT_MAX_REDIRECTS = 3;
export const DEFAULT_MAX_BYTES: number = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export type FetchImplementation = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export interface GuardedFetchOptions extends NetworkPolicy {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
  /** Injected in tests. Production always resolves through `node:dns`. */
  readonly resolver?: DnsResolver;
  readonly fetchImpl?: FetchImplementation;
}

export interface PinnedTarget {
  readonly url: string;
  readonly host: string;
  /** Validated and in connection order. The dispatcher may use only these. */
  readonly addresses: readonly PinnedAddress[];
  /** The host matched `allowedHosts`, so address classification was skipped. */
  readonly exempt: boolean;
}

export interface GuardedFetchResult {
  /** Body already capped. `status`, `headers` and streaming are untouched. */
  readonly response: Response;
  /** The final URL. Differs from the request when redirects were followed. */
  readonly url: string;
  readonly redirects: readonly string[];
  /** The address actually connected to, for the audit log. */
  readonly address: string;
}

/** Headers that must not survive a change of origin. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
]);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

function blocked(
  message: string,
  details: Readonly<Record<string, unknown>>,
): GhostError {
  // Explicitly not retryable: `network` defaults to retryable because DNS and
  // TCP failures are transient, but a blocked target will be blocked again and
  // a retry loop against it is just a slower refusal.
  return new GhostError('network', message, { retryable: false, details });
}

export const systemResolver: DnsResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({
    address: result.address,
    family: result.family === 6 ? 6 : 4,
  }));
};

/** Exact match, or a leading-dot entry matching the host and its subdomains. */
function hostMatches(host: string, patterns: readonly string[]): boolean {
  const needle = host.toLowerCase();
  return patterns.some((pattern) => {
    const entry = pattern.trim().toLowerCase();
    if (entry === '') return false;
    if (entry.startsWith('.')) {
      return needle === entry.slice(1) || needle.endsWith(entry);
    }
    return needle === entry;
  });
}

function isPermitted(range: AddressRange, policy: NetworkPolicy): boolean {
  if (range.category === 'loopback') return policy.allowLoopback === true;
  if (range.category === 'private') return policy.allowPrivate === true;
  // Link-local (the cloud metadata endpoint), multicast, the unspecified
  // address and the transition prefixes have no legitimate agent use and no
  // flag unlocks them.
  return false;
}

/**
 * Resolves and validates a URL, returning the addresses a request to it may use.
 *
 * Exported because the MCP HTTP transport and the media proxy validate a URL at
 * configuration time, before any request exists.
 */
export async function validateTarget(
  rawUrl: string,
  options: NetworkPolicy & { readonly resolver?: DnsResolver } = {},
): Promise<PinnedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new GhostError('invalid_input', `Not a URL: ${rawUrl}`, {
      cause: error,
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // `file:`, `gopher:` and `data:` are the classic pivots out of an HTTP
    // client that accepts whatever scheme it is handed.
    throw blocked(`Only http and https are allowed, got "${url.protocol}"`, {
      url: rawUrl,
    });
  }
  // No empty-host check is needed below: `http` and `https` are special schemes,
  // for which the URL parser rejects an empty host outright — `new URL('http://')`
  // throws and is already handled above.
  const host = url.hostname;
  if (hostMatches(host, options.deniedHosts ?? [])) {
    throw blocked(`Host is denied by configuration: ${host}`, {
      url: rawUrl,
      host,
    });
  }
  const exempt = hostMatches(host, options.allowedHosts ?? []);

  const literal = parseIpLiteral(host);
  if (literal !== null) {
    if (!exempt) {
      const range = classifyAddress(literal);
      if (range !== null && !isPermitted(range, options)) {
        throw blocked(
          `Address ${literal.canonical} is in a blocked range (${range.label})`,
          {
            url: rawUrl,
            host,
            address: literal.canonical,
            range: range.cidr,
          },
        );
      }
    }
    return {
      url: url.href,
      host,
      addresses: [{ address: literal.canonical, family: literal.family }],
      exempt,
    };
  }

  const resolver = options.resolver ?? systemResolver;
  let resolved: readonly PinnedAddress[];
  try {
    resolved = await resolver(host);
  } catch (error) {
    throw new GhostError('network', `Cannot resolve host: ${host}`, {
      cause: error,
      details: { url: rawUrl, host },
    });
  }
  if (resolved.length === 0) {
    throw new GhostError('network', `Cannot resolve host: ${host}`, {
      details: { url: rawUrl, host },
    });
  }

  if (!exempt) {
    for (const candidate of resolved) {
      const parsed = parseIpLiteral(candidate.address);
      if (parsed === null) {
        // The resolver returned something that is not an address. Refusing is
        // the only safe reading of a result we cannot classify.
        throw blocked(`Resolver returned an unparseable address for ${host}`, {
          url: rawUrl,
          host,
          address: candidate.address,
        });
      }
      const range = classifyAddress(parsed);
      if (range !== null && !isPermitted(range, options)) {
        // Every address is checked, not just the first: the connection may use
        // any of them, so one blocked answer poisons the whole set.
        throw blocked(
          `${host} resolves to ${parsed.canonical}, which is in a blocked range (${range.label})`,
          { url: rawUrl, host, address: parsed.canonical, range: range.cidr },
        );
      }
    }
  }

  return { url: url.href, host, addresses: resolved, exempt };
}

/**
 * A `lookup` that answers from the pinned set and never touches DNS.
 *
 * Node asks for one address or for all of them depending on whether
 * `autoSelectFamily` is in play, so both shapes are answered. A request for a
 * family that was not pinned fails rather than falling back to another family:
 * silently substituting an address that was validated for a different purpose
 * is exactly the confusion this function exists to prevent.
 */
export function pinnedLookup(
  addresses: readonly PinnedAddress[],
): LookupFunction {
  return (hostname, options, callback) => {
    const family = options.family;
    const usable =
      family === 4 || family === 6
        ? addresses.filter((candidate) => candidate.family === family)
        : addresses;

    const first = usable[0];
    if (first === undefined) {
      const error: NodeJS.ErrnoException = new Error(
        `No pinned address for ${hostname} (family ${String(family ?? 'any')})`,
      );
      error.code = 'ENOTFOUND';
      callback(error, '');
      return;
    }

    if (options.all === true) {
      callback(
        null,
        usable.map((candidate) => ({
          address: candidate.address,
          family: candidate.family,
        })),
      );
      return;
    }
    callback(null, first.address, first.family);
  };
}

function pinnedAgent(target: PinnedTarget): Agent {
  return new Agent({
    connect: { lookup: pinnedLookup(target.addresses) },
    // Short, because each request owns its dispatcher: a pinned agent cannot be
    // shared across hosts, and holding sockets open after the response is read
    // would leak one file descriptor per fetch.
    keepAliveTimeout: 1000,
    keepAliveMaxTimeout: 1000,
  });
}

/**
 * Caps the body while it streams.
 *
 * Checking `content-length` is not enough — it is optional, and a hostile server
 * simply omits it — so the bytes are counted as they arrive and the stream is
 * errored the moment the budget is exceeded.
 */
function capBody(response: Response, maxBytes: number): Response {
  const body = response.body;
  if (body === null || maxBytes <= 0) return response;

  let seen = 0;
  const capped = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(
            blocked(`Response body exceeded ${String(maxBytes)} bytes`, {
              maxBytes,
            }),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(capped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function normaliseHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

function stripCredentials(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name)),
  );
}

/**
 * Fetches a URL under the network policy, following redirects by hand.
 *
 * `redirect: 'manual'` is not a preference: undici's own redirect following
 * would connect to the next hop through the dispatcher pinned for the *previous*
 * host, which is both wrong and unvalidated.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<GuardedFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl =
    options.fetchImpl ?? ((url, init) => undiciFetch(url, init));

  const signals: AbortSignal[] = [];
  if (options.signal !== undefined) signals.push(options.signal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  const signal = signals.length === 0 ? undefined : AbortSignal.any(signals);

  const redirects: string[] = [];
  let currentUrl = rawUrl;
  let method = options.method ?? 'GET';
  let body = options.body;
  let headers = normaliseHeaders(options.headers ?? {});

  for (let hop = 0; ; hop += 1) {
    const target = await validateTarget(currentUrl, options);
    const agent = pinnedAgent(target);

    let response: Response;
    try {
      response = await fetchImpl(target.url, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
        ...(signal === undefined ? {} : { signal }),
        dispatcher: agent,
      });
    } catch (error) {
      // Graceful close would wait for a request that already failed.
      await agent.destroy();
      throw new GhostError('network', `Request to ${target.host} failed`, {
        cause: error,
        details: { url: target.url, host: target.host },
      });
    }

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) {
      // `close` rather than `destroy`: it waits for the body still streaming to
      // the caller, then releases the socket.
      void agent.close().catch(() => undefined);
      return {
        response: capBody(response, maxBytes),
        url: target.url,
        redirects,
        address: target.addresses[0]?.address ?? '',
      };
    }

    await agent.destroy();
    if (hop >= maxRedirects) {
      throw blocked(`Too many redirects (limit ${String(maxRedirects)})`, {
        url: rawUrl,
        redirects: [...redirects, location],
      });
    }

    let next: URL;
    try {
      next = new URL(location, target.url);
    } catch (error) {
      throw blocked(`Redirect target is not a URL: ${location}`, {
        url: target.url,
        location,
        cause: String(error),
      });
    }

    if (next.origin !== new URL(target.url).origin) {
      headers = stripCredentials(headers);
    }
    if (response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
    }
    redirects.push(next.href);
    currentUrl = next.href;
  }
}
