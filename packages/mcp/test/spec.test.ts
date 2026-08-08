import { McpServerConfigSchema } from '@ghostbot/protocol';
import { describe, expect, it } from 'vitest';

import {
  exposureFingerprint,
  resolveSpec,
  transportFingerprint,
} from '#src/spec.js';

/** The schema's defaults, so a case states only what it is about. */
function config(overrides: Record<string, unknown> = {}) {
  return McpServerConfigSchema.parse(overrides);
}

describe('resolveSpec', () => {
  it('infers stdio from a command', () => {
    const resolution = resolveSpec('files', config({ command: 'npx' }));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.spec.kind).toBe('stdio');
  });

  it('infers Streamable HTTP from a url, never the deprecated SSE', () => {
    const resolution = resolveSpec(
      'remote',
      config({ url: 'https://example.test/mcp' }),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.spec.kind).toBe('streamableHttp');
  });

  it('reaches SSE only when the entry asks for it by name', () => {
    const resolution = resolveSpec(
      'legacy',
      config({ type: 'sse', url: 'https://example.test/sse' }),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.spec.kind).toBe('sse');
  });

  it('trims, so a pasted command with a trailing space still resolves', () => {
    const resolution = resolveSpec('files', config({ command: '  npx  ' }));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.spec.kind === 'stdio' && resolution.spec.command).toBe(
      'npx',
    );
  });

  it('carries the arguments, environment and exposure through', () => {
    const resolution = resolveSpec(
      'files',
      config({
        command: 'npx',
        args: ['-y', 'server'],
        env: { TOKEN: 'x' },
        enabledTools: ['read'],
        toolTimeoutMs: 5_000,
      }),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok || resolution.spec.kind !== 'stdio') return;
    expect(resolution.spec.args).toEqual(['-y', 'server']);
    expect(resolution.spec.env).toEqual({ TOKEN: 'x' });
    expect(resolution.spec.enabledTools).toEqual(['read']);
    expect(resolution.spec.toolTimeoutMs).toBe(5_000);
  });

  it('refuses an entry that names neither a command nor a url', () => {
    const resolution = resolveSpec('empty', config());
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error.kind).toBe('config');
    expect(resolution.error.message).toContain('neither a command nor a url');
  });

  it('refuses an entry that names both', () => {
    const resolution = resolveSpec(
      'both',
      config({ command: 'npx', url: 'https://example.test/mcp' }),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error.message).toContain('both');
  });

  it('refuses an explicit type whose own field is missing', () => {
    // Caught here rather than as an unexplained spawn failure a minute later.
    expect(resolveSpec('a', config({ type: 'stdio' })).ok).toBe(false);
    expect(resolveSpec('b', config({ type: 'streamableHttp' })).ok).toBe(false);
  });

  it('refuses a url that is not one', () => {
    const resolution = resolveSpec('remote', config({ url: 'not a url' }));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error.message).toContain('is not a URL');
  });

  it('refuses a scheme this client does not speak', () => {
    const resolution = resolveSpec(
      'remote',
      config({ url: 'file:///etc/passwd' }),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error.message).toContain('only http and https');
  });

  it('accepts a loopback url, which the SSRF guard would have refused', () => {
    // The single most common MCP deployment. See the note on `parseUrl`.
    const resolution = resolveSpec(
      'local',
      config({ url: 'http://127.0.0.1:3001/mcp' }),
    );
    expect(resolution.ok).toBe(true);
  });
});

describe('fingerprints', () => {
  const base = config({ command: 'npx', args: ['-y', 'server'] });

  function specOf(overrides: Record<string, unknown> = {}) {
    const resolution = resolveSpec('files', config({ ...base, ...overrides }));
    if (!resolution.ok) throw resolution.error;
    return resolution.spec;
  }

  it('moves the transport fingerprint when the process would change', () => {
    expect(transportFingerprint(specOf())).not.toBe(
      transportFingerprint(specOf({ args: ['-y', 'other'] })),
    );
    expect(transportFingerprint(specOf())).not.toBe(
      transportFingerprint(specOf({ env: { TOKEN: 'x' } })),
    );
  });

  it('holds the transport fingerprint still when only exposure changed', () => {
    // The whole reason there are two: narrowing `enabledTools` must not kill
    // and respawn a subprocess to re-filter a list already in memory.
    expect(transportFingerprint(specOf())).toBe(
      transportFingerprint(specOf({ enabledTools: ['read'] })),
    );
    expect(exposureFingerprint(specOf())).not.toBe(
      exposureFingerprint(specOf({ enabledTools: ['read'] })),
    );
    expect(exposureFingerprint(specOf())).not.toBe(
      exposureFingerprint(specOf({ toolTimeoutMs: 1_000 })),
    );
  });
});
