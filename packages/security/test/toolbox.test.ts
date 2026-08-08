import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { GhostError } from '@ghostbot/core';
import type {
  AgentToolboxNetwork,
  ToolboxNetworkMode,
} from '@ghostbot/protocol';

import {
  assertNetworkWithinCeiling,
  assertToolboxPolicy,
  effectiveNetwork,
  manifestHash,
  parseToolbox,
} from '#src/toolbox.js';

const DIGEST = 'sha256:'.concat('a'.repeat(64));

function manifest(overrides: Record<string, unknown> = {}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      schema: 'ghostai.toolbox/1',
      name: 'kali-pentest',
      image: `docker.io/kalilinux/kali-rolling@${DIGEST}`,
      ...overrides,
    }),
  );
}

function network(
  mode: ToolboxNetworkMode,
  allow: string[] = [],
): AgentToolboxNetwork {
  return { mode, allow };
}

describe('manifestHash', () => {
  it('hashes the exact bytes, so formatting is a different toolbox', () => {
    // The approval is keyed on this. Two manifests that mean the same thing but
    // differ in whitespace must not share an approval — the operator reviewed
    // one file, not a family of equivalent ones.
    const compact = Buffer.from('{"a":1}');
    const spaced = Buffer.from('{ "a": 1 }');
    expect(manifestHash(compact)).not.toBe(manifestHash(spaced));
    expect(manifestHash(compact)).toBe(manifestHash(Buffer.from('{"a":1}')));
  });

  it('produces a 64-character hex digest', () => {
    expect(manifestHash(Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseToolbox', () => {
  it('fills every default from a minimal manifest', () => {
    const toolbox = parseToolbox(manifest());
    expect(toolbox.runtime).toBe('runc');
    expect(toolbox.workdir).toBe('/workspace');
    expect(toolbox.caps.drop).toEqual(['ALL']);
    expect(toolbox.caps.add).toEqual([]);
    expect(toolbox.security.noNewPrivileges).toBe(true);
    expect(toolbox.security.seccomp).toBe('default');
    expect(toolbox.network.maxMode).toBe('none');
    expect(toolbox.network.dns).toEqual(['127.0.0.11']);
  });

  it('refuses bytes that are not JSON', () => {
    expect(() => parseToolbox(Buffer.from('not json'))).toThrow(GhostError);
    expect(() => parseToolbox(Buffer.from('not json'))).toThrow(
      /not valid JSON/,
    );
  });

  it('refuses an unrecognised schema version', () => {
    expect(() =>
      parseToolbox(manifest({ schema: 'ghostai.sandbox-toolbox/2' })),
    ).toThrow(/not valid/);
  });

  it('names the offending field when the shape is wrong', () => {
    expect(() => parseToolbox(manifest({ runtime: 'containerd' }))).toThrow(
      /runtime/,
    );
  });
});

describe('assertToolboxPolicy', () => {
  it('accepts a digest-pinned image', () => {
    expect(() => {
      assertToolboxPolicy(parseToolbox(manifest()));
    }).not.toThrow();
  });

  it('refuses an image pinned by tag', () => {
    // The whole approval gate rests on this: a tag can be repointed after the
    // operator approved it, and every recorded hash would still match.
    const toolbox = parseToolbox(
      manifest({ image: 'kalilinux/kali-rolling:latest' }),
    );
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).toThrow(/digest/);
  });

  it('refuses an image with a malformed digest', () => {
    const toolbox = parseToolbox(manifest({ image: 'kali@sha256:abc' }));
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).toThrow(/digest/);
  });

  it.each([
    'NET_ADMIN',
    'CAP_NET_ADMIN',
    'net_admin',
    'SYS_ADMIN',
    'SYS_MODULE',
  ])('refuses the %s capability however it is spelled', (capability) => {
    // A sandbox shares the gateway's network namespace, so NET_ADMIN would let
    // it flush the very rules that scope its egress.
    const toolbox = parseToolbox(manifest({ caps: { add: [capability] } }));
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).toThrow(GhostError);
  });

  it('permits NET_RAW, which is what a SYN scan needs', () => {
    const toolbox = parseToolbox(manifest({ caps: { add: ['NET_RAW'] } }));
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).not.toThrow();
  });

  it('permits unconfined seccomp, which rootless builds require', () => {
    // Surfaced in the install review rather than refused: it is dangerous, but
    // it does not break machinery the operator cannot reason about.
    const toolbox = parseToolbox(
      manifest({ security: { seccomp: 'unconfined' } }),
    );
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).not.toThrow();
  });

  it('refuses an empty proxy host entry', () => {
    const toolbox = parseToolbox(
      manifest({ network: { proxyAllowHosts: ['  '] } }),
    );
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).toThrow(/empty proxy host/);
  });
});

describe('assertNetworkWithinCeiling', () => {
  const ceiling = (maxMode: ToolboxNetworkMode) =>
    parseToolbox(manifest({ network: { maxMode } }));

  it('refuses an agent asking for more than the toolbox permits', () => {
    expect(() => {
      assertNetworkWithinCeiling(
        ceiling('allowlist'),
        network('open'),
        'pentest',
      );
    }).toThrow(/permits at most/);
  });

  it('refuses any network against a toolbox whose ceiling is none', () => {
    expect(() => {
      assertNetworkWithinCeiling(
        ceiling('none'),
        network('allowlist', ['10.0.0.0/8']),
        'malware',
      );
    }).toThrow(/permits at most/);
  });

  it('accepts a request at or below the ceiling', () => {
    expect(() => {
      assertNetworkWithinCeiling(
        ceiling('open'),
        network('allowlist', ['10.0.0.0/8']),
        'a',
      );
    }).not.toThrow();
    expect(() => {
      assertNetworkWithinCeiling(ceiling('open'), network('none'), 'a');
    }).not.toThrow();
  });

  it('refuses an allow-list with no entries', () => {
    expect(() => {
      assertNetworkWithinCeiling(ceiling('open'), network('allowlist'), 'a');
    }).toThrow(/reaches nothing/);
  });

  it.each([
    'example.com',
    '10.0.0.1',
    'not a cidr',
    '10.0.0.0/64',
    '10.0.0.0/+8',
  ])('refuses %s, which is not a CIDR block', (entry) => {
    // Hostnames especially: an allow-list resolved by name is defeated by DNS
    // rebinding, which is the attack guardedFetch already exists to stop.
    expect(() => {
      assertNetworkWithinCeiling(
        ceiling('open'),
        network('allowlist', [entry]),
        'a',
      );
    }).toThrow(/CIDR/);
  });

  it('accepts private ranges, which is the whole point of an engagement scope', () => {
    // Deliberately opposite to guardedFetch's policy, where 192.168/16 is
    // blocked. Same parsing, different question.
    expect(() => {
      assertNetworkWithinCeiling(
        ceiling('open'),
        network('allowlist', ['192.168.1.0/24']),
        'a',
      );
    }).not.toThrow();
  });
});

describe('effectiveNetwork', () => {
  it('drops the allow-list when the resolved mode is not allowlist', () => {
    const resolved = effectiveNetwork(
      parseToolbox(manifest({ network: { maxMode: 'none' } })),
      network('allowlist', ['10.0.0.0/8']),
    );
    expect(resolved.mode).toBe('none');
    expect(resolved.allow).toEqual([]);
  });

  it('carries the toolbox dns and proxy hosts through', () => {
    const resolved = effectiveNetwork(
      parseToolbox(
        manifest({
          network: {
            maxMode: 'open',
            dns: ['1.1.1.1'],
            proxyAllowHosts: ['deb.debian.org'],
          },
        }),
      ),
      network('open'),
    );
    expect(resolved.dns).toEqual(['1.1.1.1']);
    expect(resolved.proxyAllowHosts).toEqual(['deb.debian.org']);
  });

  it('never widens beyond the toolbox ceiling, for any pair', () => {
    // The property the whole ceiling design rests on. A `min` rather than a
    // union means no ordering of calls can produce more reach than the toolbox
    // permits, whether or not the assert ran first.
    const modes: ToolboxNetworkMode[] = ['none', 'allowlist', 'open'];
    const order = (mode: ToolboxNetworkMode) => modes.indexOf(mode);

    fc.assert(
      fc.property(
        fc.constantFrom(...modes),
        fc.constantFrom(...modes),
        (maxMode, requested) => {
          const resolved = effectiveNetwork(
            parseToolbox(manifest({ network: { maxMode } })),
            network(requested, ['10.0.0.0/8']),
          );
          expect(order(resolved.mode)).toBeLessThanOrEqual(order(maxMode));
          expect(order(resolved.mode)).toBeLessThanOrEqual(order(requested));
        },
      ),
    );
  });
});

describe('assertToolboxPolicy: the image reference is a reference, not an argument', () => {
  it.each([
    `-v/:/hostfs@${DIGEST}`,
    `--privileged@${DIGEST}`,
    ` alpine@${DIGEST}`,
    `alpine@${DIGEST} --privileged`,
  ])('refuses %j, which could be read as a flag', (image) => {
    // The image is pushed to `docker run` as a bare argv token. A pattern
    // anchored only at the end would let a manifest smuggle a flag past this.
    const toolbox = parseToolbox(manifest({ image }));
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).toThrow(/digest/);
  });

  it.each([
    `sha256:${'a'.repeat(64)}`,
    `alpine@sha256:${'a'.repeat(64)}`,
    `docker.io/library/alpine@sha256:${'a'.repeat(64)}`,
    `registry.example.com:5000/team/img@sha256:${'a'.repeat(64)}`,
  ])('accepts the legitimate reference %j', (image) => {
    const toolbox = parseToolbox(manifest({ image }));
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).not.toThrow();
  });
});

describe('assertToolboxPolicy: an entry may not shadow a built-in', () => {
  it.each(['read_file', 'write_file', 'edit_file', 'list_dir', 'exec'])(
    'refuses a program declared as %s',
    (name) => {
      // Under `expose: 'tools'` a declared entry becomes a callable. One named
      // `read_file` would shadow the jailed built-in with an unjailed shell
      // command — and no operator reading a manifest would spot that a program
      // name is also a tool name.
      const toolbox = parseToolbox(manifest({ tools: [{ name }] }));
      expect(() => {
        assertToolboxPolicy(toolbox);
      }).toThrow(/built-in tool/);
    },
  );

  it('permits a program whose name merely resembles one', () => {
    const toolbox = parseToolbox(
      manifest({ tools: [{ name: 'readfile' }, { name: 'execute' }] }),
    );
    expect(() => {
      assertToolboxPolicy(toolbox);
    }).not.toThrow();
  });
});
