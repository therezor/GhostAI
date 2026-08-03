import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BLOCKED_RANGES,
  type ParsedIp,
  cidrContains,
  classifyAddress,
  parseCidr,
  parseIpLiteral,
} from '#src/ip.js';

const parse = (host: string): ParsedIp => {
  const parsed = parseIpLiteral(host);
  if (parsed === null) {
    throw new Error(`expected ${host} to parse as an address`);
  }
  return parsed;
};

const category = (host: string): string | null =>
  classifyAddress(parse(host))?.category ?? null;

describe('parseIpLiteral: IPv4 encodings', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['8.8.8.8', '8.8.8.8'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    // Decimal: what `getaddrinfo` does with a bare integer.
    ['2130706433', '127.0.0.1'],
    ['3232235777', '192.168.1.1'],
    // Octal, per part and whole.
    ['0177.0.0.1', '127.0.0.1'],
    ['0177.0.0.01', '127.0.0.1'],
    ['017700000001', '127.0.0.1'],
    // Hex, per part and whole.
    ['0x7f.0.0.1', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['0X7F000001', '127.0.0.1'],
    // Short forms: the last part absorbs the remaining bytes.
    ['127.1', '127.0.0.1'],
    ['127.0.1', '127.0.0.1'],
    ['192.168.257', '192.168.1.1'],
    ['10.0xffff', '10.0.255.255'],
    // A trailing dot is the DNS root label. Stripping it before the numeric
    // parse errs toward treating the host as an address, which is the safe
    // direction for a guard: `127.0.0.1.` must not reach a name lookup.
    ['127.0.0.1.', '127.0.0.1'],
    ['1.2.3.', '1.2.0.3'],
    ['  127.0.0.1  ', '127.0.0.1'],
  ])('parses %j as %s', (input, expected) => {
    expect(parse(input).canonical).toBe(expected);
    expect(parse(input).family).toBe(4);
  });

  it.each([
    'example.com',
    'localhost',
    '',
    '   ',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.256.1.1',
    '4294967296',
    '127.0.0.256',
    '08.1.1.1',
    '0x.1.1.1',
    '0x',
    '1..2',
    '.1.2.3',
    'a.b.c.d',
    '-1.0.0.1',
    '1.2.3.4/8',
    '127.0.0.1x',
    '127.0.0.1.evil.com',
  ])('does not treat %j as an address', (input) => {
    expect(parseIpLiteral(input)).toBeNull();
  });
});

describe('parseIpLiteral: IPv6', () => {
  it.each([
    ['::1', '::1'],
    ['::', '::'],
    ['[::1]', '::1'],
    ['fe80::1', 'fe80::1'],
    ['fe80::1%eth0', 'fe80::1'],
    ['[fe80::1%25eth0]', 'fe80::1'],
    ['2606:4700:4700::1111', '2606:4700:4700::1111'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['fc00:0:0:0:0:0:0:0', 'fc00::'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['FE80::ABCD', 'fe80::abcd'],
    // Deprecated IPv4-compatible form: stays IPv6 and is caught by `::/96`.
    ['::7f00:1', '::7f00:1'],
  ])('parses %j as %s', (input, expected) => {
    const parsed = parse(input);
    expect(parsed.family).toBe(6);
    expect(parsed.canonical).toBe(expected);
  });

  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'],
    ['[::ffff:169.254.169.254]', '169.254.169.254'],
    ['0:0:0:0:0:ffff:0a00:0001', '10.0.0.1'],
  ])('unwraps the IPv4-mapped address %j to %s', (input, expected) => {
    const parsed = parse(input);
    // Returned as family 4 so it meets the IPv4 table: the whole point of the
    // encoding is that a v6-only check would let it past.
    expect(parsed.family).toBe(4);
    expect(parsed.canonical).toBe(expected);
  });

  it.each([
    '1::2::3',
    ':::',
    'gggg::1',
    '12345::1',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    '1:2:3:4:5:6:7:8::9',
    '::1.2.3',
    '::1.2.3.4.5',
    '::1.2.3.256',
    '::0x7f.0.0.1',
    '1.2.3.4::5',
    ':1',
    '1:',
    '::ffff:',
  ])('rejects the malformed literal %j', (input) => {
    expect(parseIpLiteral(input)).toBeNull();
  });
});

describe('classifyAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['::1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['169.254.169.254', 'link-local'],
    ['fe80::1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['::', 'unspecified'],
    ['::7f00:1', 'unspecified'],
    ['224.0.0.1', 'multicast'],
    ['ff02::1', 'multicast'],
    ['255.255.255.255', 'reserved'],
    ['64:ff9b::7f00:1', 'reserved'],
    ['2002::1', 'reserved'],
    ['2001::1', 'reserved'],
    ['2001:db8::1', 'reserved'],
  ])('classifies %s as %s', (host, expected) => {
    expect(category(host)).toBe(expected);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1',
    '172.15.0.1',
    '2606:4700::1111',
  ])('leaves the routable address %s unclassified', (host) => {
    expect(classifyAddress(parse(host))).toBeNull();
  });

  it('prefers the most specific range, so ::1 is loopback and not merely ::/96', () => {
    // Category drives policy: a deployment that allows loopback to reach its own
    // model server must get the same answer for [::1] as for 127.0.0.1.
    expect(classifyAddress(parse('::1'))?.cidr).toBe('::1/128');
  });

  it('blocks every encoding of the same loopback address', () => {
    for (const host of [
      '127.0.0.1',
      '2130706433',
      '0177.0.0.1',
      '0x7f000001',
      '127.1',
      '127.0.0.1.',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '[::ffff:127.0.0.1]',
    ]) {
      expect(category(host)).toBe('loopback');
    }
  });

  it('blocks every encoding of the cloud metadata endpoint', () => {
    for (const host of [
      '169.254.169.254',
      '2852039166',
      '0251.0376.0251.0376',
      '0xa9fea9fe',
      '169.254.43518',
      '::ffff:a9fe:a9fe',
    ]) {
      expect(category(host)).toBe('link-local');
    }
  });
});

describe('BLOCKED_RANGES', () => {
  it('parses every entry, in both families', () => {
    expect(BLOCKED_RANGES.length).toBeGreaterThan(20);
    for (const range of BLOCKED_RANGES) {
      const [address, prefix] = range.cidr.split('/');
      expect(
        address === undefined ? null : parseIpLiteral(address),
      ).not.toBeNull();
      expect(Number.parseInt(prefix ?? '', 10)).toBeGreaterThanOrEqual(0);
    }
  });

  it('has no duplicate CIDRs', () => {
    const cidrs = BLOCKED_RANGES.map((range) => range.cidr);
    expect(new Set(cidrs).size).toBe(cidrs.length);
  });
});

describe('property: encoding cannot smuggle a blocked address past the guard', () => {
  const formatIpv4 = (bytes: readonly number[], style: number): string => {
    const [a = 0, b = 0, c = 0, d = 0] = bytes;
    const whole = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
    const dotted = [a, b, c, d].map(String);
    switch (style) {
      case 0:
        return dotted.join('.');
      case 1:
        return String(whole);
      case 2:
        return `0x${whole.toString(16)}`;
      case 3:
        return [a, b, c, d].map((byte) => `0${byte.toString(8)}`).join('.');
      case 4:
        return [a, b, c * 256 + d].map(String).join('.');
      case 5:
        return `${dotted.join('.')}.`;
      default:
        return `::ffff:${dotted.join('.')}`;
    }
  };

  /** Every generated address lies inside a range the table blocks. */
  const blockedIpv4 = fc.oneof(
    fc.tuple(fc.constant(127), fc.nat(255), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(10), fc.nat(255), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(192), fc.constant(168), fc.nat(255), fc.nat(255)),
    fc.tuple(fc.constant(169), fc.constant(254), fc.nat(255), fc.nat(255)),
    fc.tuple(
      fc.constant(172),
      fc.integer({ min: 16, max: 31 }),
      fc.nat(255),
      fc.nat(255),
    ),
    fc.tuple(
      fc.constant(100),
      fc.integer({ min: 64, max: 127 }),
      fc.nat(255),
      fc.nat(255),
    ),
  );

  it('holds across decimal, octal, hex, short and IPv4-mapped forms', () => {
    fc.assert(
      fc.property(
        blockedIpv4,
        fc.integer({ min: 0, max: 6 }),
        (bytes, style) => {
          const host = formatIpv4(bytes, style);
          const parsed = parseIpLiteral(host);
          expect(parsed).not.toBeNull();
          if (parsed === null) return;
          expect(classifyAddress(parsed)).not.toBeNull();
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('agrees on the canonical form whichever encoding was used', () => {
    fc.assert(
      fc.property(blockedIpv4, (bytes) => {
        const canonical = parse(formatIpv4(bytes, 0)).canonical;
        for (const style of [1, 2, 3, 5, 6]) {
          expect(parse(formatIpv4(bytes, style)).canonical).toBe(canonical);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('never crashes on arbitrary host strings', () => {
    fc.assert(
      fc.property(fc.string(), (host) => {
        const parsed = parseIpLiteral(host);
        if (parsed !== null) {
          expect(parsed.bytes.byteLength).toBe(parsed.family === 4 ? 4 : 16);
          classifyAddress(parsed);
        }
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseCidr', () => {
  it.each([
    ['10.0.0.0/8', 4, 8],
    ['192.168.1.0/24', 4, 24],
    ['0.0.0.0/0', 4, 0],
    ['10.1.2.3/32', 4, 32],
    ['2001:db8::/32', 6, 32],
    ['::/0', 6, 0],
  ])('parses %s', (text, family, prefix) => {
    const parsed = parseCidr(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.family).toBe(family);
    expect(parsed?.prefix).toBe(prefix);
  });

  it.each([
    ['10.0.0.0', 'no prefix at all'],
    ['10.0.0.0/', 'an empty prefix'],
    ['10.0.0.0/8abc', 'trailing rubbish after the digits'],
    ['10.0.0.0/+8', 'a signed prefix'],
    ['10.0.0.0/ 8', 'whitespace Number.parseInt would have accepted'],
    ['10.0.0.0/33', 'a prefix wider than the family'],
    ['2001:db8::/129', 'a prefix wider than IPv6'],
    ['not-an-address/8', 'an address that does not parse'],
    ['/8', 'no address'],
  ])('refuses %s (%s)', (text) => {
    expect(parseCidr(text)).toBeNull();
  });

  it('takes the last slash, so an IPv6 block still parses', () => {
    expect(parseCidr('2001:db8::/32')?.prefix).toBe(32);
  });
});

describe('cidrContains', () => {
  const contains = (cidr: string, host: string): boolean => {
    const block = parseCidr(cidr);
    if (block === null) throw new Error(`expected ${cidr} to parse`);
    return cidrContains(block, parse(host));
  };

  it.each([
    ['10.0.0.0/8', '10.255.255.255', true],
    ['10.0.0.0/8', '11.0.0.1', false],
    ['192.168.1.0/24', '192.168.1.42', true],
    ['192.168.1.0/24', '192.168.2.42', false],
    ['10.1.2.3/32', '10.1.2.3', true],
    ['10.1.2.3/32', '10.1.2.4', false],
    ['0.0.0.0/0', '203.0.113.9', true],
  ])('%s contains %s → %s', (cidr, host, expected) => {
    expect(contains(cidr, host)).toBe(expected);
  });

  it('handles a prefix that does not land on a byte boundary', () => {
    // 10.0.0.0/12 covers 10.0.0.0 – 10.15.255.255. The partial-byte mask is the
    // part of prefix matching most likely to be written wrong.
    expect(contains('10.0.0.0/12', '10.15.255.255')).toBe(true);
    expect(contains('10.0.0.0/12', '10.16.0.0')).toBe(false);
  });

  it('never matches across families', () => {
    // An IPv4-shaped rule must not silently authorise an IPv6 destination.
    expect(contains('0.0.0.0/0', '::1')).toBe(false);
    expect(contains('::/0', '10.0.0.1')).toBe(false);
  });

  it('never crashes on arbitrary CIDR strings', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const parsed = parseCidr(text);
        if (parsed !== null) {
          expect(parsed.prefix).toBeLessThanOrEqual(
            parsed.bytes.byteLength * 8,
          );
          cidrContains(parsed, parse('10.0.0.1'));
        }
      }),
      { numRuns: 2000 },
    );
  });
});
