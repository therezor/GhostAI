/**
 * Address literal parsing, and the ranges egress may never reach.
 *
 * A URL host is not safe to classify by string comparison, because the resolver
 * that eventually connects is far more liberal than a naive reader assumes.
 * `getaddrinfo` accepts `inet_aton` forms, so every one of these reaches
 * 127.0.0.1:
 *
 *     http://2130706433/        decimal
 *     http://0177.0.0.1/        octal
 *     http://0x7f.1/            hex, with the last part absorbing the rest
 *     http://127.1/             short form
 *     http://[::ffff:7f00:1]/   IPv4 mapped into IPv6
 *
 * A guard that checks `hostname === 'localhost'`, or that only understands
 * dotted quads, passes all five. So parsing happens here, with the same
 * semantics the resolver uses, before anything is treated as a hostname —
 * `parseIpLiteral` returning `null` is what earns a string a DNS lookup.
 *
 * The blocked table is data, and deliberately wider than "private". Cloud
 * metadata at 169.254.169.254 is the single highest-value SSRF target in
 * existence and it is link-local, not private. The IPv6 transition prefixes
 * (6to4, Teredo, NAT64) embed IPv4 addresses and are blocked wholesale rather
 * than unwrapped, because a partially-correct unwrapper is worse than a refusal
 * for ranges no agent has a reason to fetch from.
 */

import { GhostError } from '@ghostai/core';

export type IpFamily = 4 | 6;

export interface ParsedIp {
  readonly family: IpFamily;
  /** Dotted quad, or the RFC 5952 compressed IPv6 form. For logs and messages. */
  readonly canonical: string;
  /** 4 bytes for IPv4, 16 for IPv6. */
  readonly bytes: Uint8Array;
}

/**
 * Why a range is blocked. The network policy keys off this: `allowLoopback`
 * exists because a self-hosted agent's own model server is at 127.0.0.1, and
 * `allowPrivate` because a LAN deployment is legitimate. Nothing unlocks
 * `link-local` — that is the metadata endpoint.
 */
export type AddressCategory =
  'loopback' | 'private' | 'link-local' | 'multicast' | 'unspecified' | 'reserved';

export interface AddressRange {
  readonly cidr: string;
  readonly label: string;
  readonly category: AddressCategory;
}

export const BLOCKED_RANGES: readonly AddressRange[] = [
  { cidr: '0.0.0.0/8', label: 'this network', category: 'unspecified' },
  { cidr: '10.0.0.0/8', label: 'private', category: 'private' },
  { cidr: '100.64.0.0/10', label: 'carrier-grade NAT', category: 'private' },
  { cidr: '127.0.0.0/8', label: 'loopback', category: 'loopback' },
  { cidr: '169.254.0.0/16', label: 'link-local and cloud metadata', category: 'link-local' },
  { cidr: '172.16.0.0/12', label: 'private', category: 'private' },
  { cidr: '192.0.0.0/24', label: 'IETF protocol assignments', category: 'reserved' },
  { cidr: '192.0.2.0/24', label: 'documentation', category: 'reserved' },
  { cidr: '192.88.99.0/24', label: '6to4 relay anycast', category: 'reserved' },
  { cidr: '192.168.0.0/16', label: 'private', category: 'private' },
  { cidr: '198.18.0.0/15', label: 'benchmarking', category: 'reserved' },
  { cidr: '198.51.100.0/24', label: 'documentation', category: 'reserved' },
  { cidr: '203.0.113.0/24', label: 'documentation', category: 'reserved' },
  { cidr: '224.0.0.0/4', label: 'multicast', category: 'multicast' },
  { cidr: '240.0.0.0/4', label: 'reserved, including broadcast', category: 'reserved' },
  // `::/96` covers both the unspecified address and the deprecated
  // IPv4-compatible form `::127.0.0.1`. IPv4-*mapped* addresses are not here:
  // `parseIpLiteral` returns them as family 4, so they meet the table above.
  { cidr: '::/96', label: 'unspecified and IPv4-compatible', category: 'unspecified' },
  { cidr: '::1/128', label: 'loopback', category: 'loopback' },
  { cidr: '64:ff9b::/96', label: 'NAT64, embeds IPv4', category: 'reserved' },
  { cidr: '100::/64', label: 'discard-only', category: 'reserved' },
  { cidr: '2001::/32', label: 'Teredo, embeds IPv4', category: 'reserved' },
  { cidr: '2001:db8::/32', label: 'documentation', category: 'reserved' },
  { cidr: '2002::/16', label: '6to4, embeds IPv4', category: 'reserved' },
  { cidr: 'fc00::/7', label: 'unique local', category: 'private' },
  { cidr: 'fe80::/10', label: 'link-local', category: 'link-local' },
  { cidr: 'ff00::/8', label: 'multicast', category: 'multicast' },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HEX_PART = /^0[xX][0-9a-fA-F]+$/;
const OCTAL_PART = /^0[0-7]+$/;
const DECIMAL_PART = /^(?:0|[1-9][0-9]*)$/;
const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;

/** One `inet_aton` component: hex, octal or decimal, in that precedence. */
function parseNumericPart(part: string): number | null {
  if (HEX_PART.test(part)) return Number.parseInt(part.slice(2), 16);
  if (OCTAL_PART.test(part)) return Number.parseInt(part.slice(1), 8);
  if (DECIMAL_PART.test(part)) return Number.parseInt(part, 10);
  return null;
}

function ipv4FromBytes(bytes: Uint8Array): ParsedIp {
  return { family: 4, canonical: bytes.join('.'), bytes };
}

/**
 * `inet_aton` semantics: one to four parts, each hex/octal/decimal, where the
 * final part fills all remaining low-order bytes.
 */
function parseIpv4Numeric(text: string): ParsedIp | null {
  if (text === '') return null;
  const parts = text.split('.');
  if (parts.length > 4) return null;

  const lastIndex = parts.length - 1;
  const bytes = new Uint8Array(4);
  let last = 0;
  for (const [index, part] of parts.entries()) {
    const value = parseNumericPart(part);
    if (value === null) return null;
    if (index === lastIndex) {
      // The final part fills every byte the earlier parts did not.
      if (value >= 2 ** (8 * (4 - lastIndex))) return null;
      last = value;
      break;
    }
    if (value > 0xff) return null;
    bytes[index] = value;
  }

  let remainder = last;
  for (let index = 3; index >= lastIndex; index -= 1) {
    bytes[index] = remainder % 0x100;
    remainder = Math.floor(remainder / 0x100);
  }
  return ipv4FromBytes(bytes);
}

/** Strict dotted quad. What is legal *inside* an IPv6 literal — no octal, no short forms. */
function parseDottedQuad(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    if (!DECIMAL_PART.test(part)) return null;
    const value = Number.parseInt(part, 10);
    if (value > 0xff) return null;
    bytes[index] = value;
  }
  return bytes;
}

/**
 * `terminal` says whether this half ends the address. An embedded IPv4 address
 * is only legal in the final position of the whole literal, so `1.2.3.4::5` has
 * to be refused even though the quad ends the half it appears in.
 */
function ipv6GroupsToBytes(groups: readonly string[], terminal: boolean): Uint8Array | null {
  const out: number[] = [];
  for (const [index, group] of groups.entries()) {
    if (group === '') return null;
    if (group.includes('.')) {
      if (!terminal || index !== groups.length - 1) return null;
      const quad = parseDottedQuad(group);
      if (quad === null) return null;
      out.push(...quad);
      continue;
    }
    if (!IPV6_GROUP.test(group)) return null;
    const value = Number.parseInt(group, 16);
    out.push(value >>> 8, value & 0xff);
  }
  return out.length > 16 ? null : new Uint8Array(out);
}

/** `::ffff:a.b.c.d` — an IPv4 address wearing an IPv6 costume. */
function isIpv4Mapped(bytes: Uint8Array): boolean {
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return bytes[10] === 0xff && bytes[11] === 0xff;
}

function formatIpv6(bytes: Uint8Array): string {
  // Through a DataView rather than by index, so the reads are typed as numbers
  // and there is no impossible `undefined` case to branch on.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groups: number[] = [];
  for (let index = 0; index < 16; index += 2) groups.push(view.getUint16(index));

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let index = 0; index <= groups.length; index += 1) {
    if (index < groups.length && groups[index] === 0) {
      if (runStart === -1) runStart = index;
      continue;
    }
    if (runStart !== -1) {
      const length = index - runStart;
      // RFC 5952: only a run of two or more groups is compressed.
      if (length > bestLength && length > 1) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }

  const text = groups.map((group) => group.toString(16));
  if (bestStart === -1) return text.join(':');
  const head = text.slice(0, bestStart).join(':');
  const tail = text.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

function parseIpv6(text: string): ParsedIp | null {
  const halves = text.split('::');
  if (halves.length > 2) return null;

  const headText = halves[0] ?? '';
  const tailText = halves.length === 2 ? (halves[1] ?? '') : null;
  const head = ipv6GroupsToBytes(headText === '' ? [] : headText.split(':'), tailText === null);
  const tail = ipv6GroupsToBytes(
    tailText === null || tailText === '' ? [] : tailText.split(':'),
    true,
  );
  if (head === null || tail === null) return null;

  let bytes: Uint8Array;
  if (tailText === null) {
    if (head.length !== 16) return null;
    bytes = head;
  } else {
    // `::` must stand for at least one elided group, so the explicit halves
    // cannot themselves add up to a whole address.
    if (head.length + tail.length > 14) return null;
    bytes = new Uint8Array(16);
    bytes.set(head, 0);
    bytes.set(tail, 16 - tail.length);
  }

  if (isIpv4Mapped(bytes)) return ipv4FromBytes(bytes.slice(12));
  return { family: 6, canonical: formatIpv6(bytes), bytes };
}

/**
 * Parses a host as an address literal, or returns `null` if it is a name.
 *
 * `null` is the only thing that earns a host a DNS lookup, so anything the
 * resolver would treat as numeric must be recognised here.
 */
export function parseIpLiteral(host: string): ParsedIp | null {
  let text = host.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);

  const zoneIndex = text.indexOf('%');
  if (zoneIndex !== -1) text = text.slice(0, zoneIndex);

  if (text.includes(':')) return parseIpv6(text);
  // A trailing dot is the DNS root label on a name, and is ignored by the
  // resolver on a numeric form. `127.0.0.1.` must not slip through as a name.
  if (text.endsWith('.')) text = text.slice(0, -1);
  return parseIpv4Numeric(text);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** A CIDR block, parsed once so containment is a byte comparison. */
export interface ParsedCidr {
  readonly family: IpFamily;
  /** The network address. Host bits are *not* masked off — see `cidrContains`. */
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

/**
 * Parses `10.0.0.0/8`, or `null` if it is not one.
 *
 * Exported because the sandbox egress allow-list needs exactly this and had no
 * business reimplementing it. Note the deliberate asymmetry with
 * `BLOCKED_RANGES`: this module's *policy* refuses private ranges for
 * `guardedFetch`, but an engagement scope is `192.168.1.0/24` and is entirely
 * legitimate. Parsing is shared; policy is the caller's.
 */
export function parseCidr(text: string): ParsedCidr | null {
  const slash = text.lastIndexOf('/');
  if (slash === -1) return null;
  const parsed = parseIpLiteral(text.slice(0, slash));
  if (parsed === null) return null;
  const prefixText = text.slice(slash + 1);
  // `Number.parseInt` would accept `8abc` and `+8`; a prefix is digits or it is
  // not a prefix.
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number.parseInt(prefixText, 10);
  if (prefix > parsed.bytes.length * 8) return null;
  return { family: parsed.family, bytes: parsed.bytes, prefix };
}

/** Whether an address falls inside a block. Families must match. */
export function cidrContains(cidr: ParsedCidr, ip: ParsedIp): boolean {
  if (cidr.family !== ip.family) return false;
  return matchesPrefix(ip.bytes, cidr.bytes, cidr.prefix);
}

interface CompiledRange {
  readonly range: AddressRange;
  readonly family: IpFamily;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function compileRange(range: AddressRange): CompiledRange {
  const parsed = parseCidr(range.cidr);
  if (parsed === null) {
    throw new GhostError('internal', `Malformed blocked range: ${range.cidr}`);
  }
  return { range, family: parsed.family, bytes: parsed.bytes, prefix: parsed.prefix };
}

/**
 * Sorted most-specific-first, so `::1` classifies as `loopback` rather than as
 * the `::/96` block that also contains it. Category drives policy — a
 * deployment that allows loopback so it can reach its own model server must get
 * the same answer for `[::1]` as for `127.0.0.1`.
 */
const COMPILED_RANGES: readonly CompiledRange[] = BLOCKED_RANGES.map(compileRange).sort(
  (left, right) => right.prefix - left.prefix,
);

function matchesPrefix(address: Uint8Array, network: Uint8Array, prefix: number): boolean {
  const wholeBytes = prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network[index]) return false;
  }
  const remainingBits = prefix & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((address[wholeBytes] ?? 0) & mask) === ((network[wholeBytes] ?? 0) & mask);
}

/** The range an address falls in, or `null` if it is publicly routable. */
export function classifyAddress(ip: ParsedIp): AddressRange | null {
  for (const compiled of COMPILED_RANGES) {
    if (compiled.family !== ip.family) continue;
    if (matchesPrefix(ip.bytes, compiled.bytes, compiled.prefix)) return compiled.range;
  }
  return null;
}
