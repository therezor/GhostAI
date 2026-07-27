import { describe, expect, it } from 'vitest';

import {
  AgentDefaultsSchema,
  ConfigPatchSchema,
  ConfigSchema,
  McpServerConfigSchema,
  ToolApprovalsConfigSchema,
  isLoopbackHost,
} from './config.js';

describe('ConfigSchema', () => {
  it('produces a fully populated tree from an empty object', () => {
    // Every nested block uses `.prefault({})`, so a brand-new install needs no
    // config file at all and `config.agents.defaults.model` is never undefined.
    const config = ConfigSchema.parse({});

    expect(config.agents.defaults.maxToolIterations).toBe(40);
    expect(config.server.port).toBe(3000);
    expect(config.server.auth.enabled).toBe(true);
    expect(config.tools.exec.enable).toBe(true);
    expect(config.tools.approvals.exec).toBe('ask');
    expect(config.tools.web.search.provider).toBe('brave');
    expect(config.scheduler.heartbeat.file).toBe('TASK.md');
    expect(config.rag.rrfK).toBe(60);
    expect(config.channels.sendProgress).toBe(true);
    expect(config.plugins.allowUnverified).toBe(false);
  });

  it('does not share mutable defaults between parses', () => {
    const a = ConfigSchema.parse({});
    const b = ConfigSchema.parse({});
    expect(a.agents.defaults.pinnedSkills).not.toBe(b.agents.defaults.pinnedSkills);
  });

  it('preserves a partial override without dropping siblings', () => {
    const config = ConfigSchema.parse({ agents: { defaults: { temperature: 0.7 } } });
    expect(config.agents.defaults.temperature).toBe(0.7);
    expect(config.agents.defaults.maxTokens).toBe(8192);
  });

  it('accepts unknown channel blocks so a channel plugin needs no schema change', () => {
    const config = ConfigSchema.parse({
      channels: { telegram: { token: 'x', allowlist: ['1|me'] } },
    });
    expect(config.channels.telegram).toEqual({ token: 'x', allowlist: ['1|me'] });
  });

  it('keys providers by id rather than a fixed field list', () => {
    const config = ConfigSchema.parse({
      providers: { ollama: { apiBase: 'http://localhost:11434' }, anthropic: {} },
    });
    expect(config.providers.ollama?.apiBase).toBe('http://localhost:11434');
    expect(config.providers.anthropic?.extraHeaders).toEqual({});
  });

  it('rejects an out-of-range port', () => {
    expect(ConfigSchema.safeParse({ server: { port: 70_000 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ server: { port: 0 } }).success).toBe(false);
  });

  it('rejects a negative timeout but allows 0 as "no limit"', () => {
    expect(AgentDefaultsSchema.safeParse({ toolTimeoutMs: -1 }).success).toBe(false);
    expect(AgentDefaultsSchema.parse({ toolTimeoutMs: 0 }).toolTimeoutMs).toBe(0);
  });

  it('rejects a non-integer iteration cap', () => {
    expect(AgentDefaultsSchema.safeParse({ maxToolIterations: 2.5 }).success).toBe(false);
  });

  it('constrains temperature to a sane range', () => {
    expect(AgentDefaultsSchema.safeParse({ temperature: 3 }).success).toBe(false);
    expect(AgentDefaultsSchema.safeParse({ temperature: -0.1 }).success).toBe(false);
  });

  it('omits an unset reasoning effort rather than defaulting it', () => {
    // A provider that does not support the parameter must not receive it at all;
    // `withResilience` drops it on a 400, and a default would mask that path.
    expect(AgentDefaultsSchema.parse({})).not.toHaveProperty('reasoningEffort');
  });

  it('rejects an unknown reasoning effort', () => {
    expect(AgentDefaultsSchema.safeParse({ reasoningEffort: 'extreme' }).success).toBe(false);
  });
});

describe('ToolApprovalsConfigSchema', () => {
  it('asks before exec and network, allows reads and jailed writes', () => {
    const approvals = ToolApprovalsConfigSchema.parse({});
    expect(approvals).toMatchObject({
      safe: 'allow',
      write: 'allow',
      exec: 'ask',
      network: 'ask',
    });
  });

  it('rejects an unknown policy', () => {
    expect(ToolApprovalsConfigSchema.safeParse({ exec: 'maybe' }).success).toBe(false);
  });
});

describe('McpServerConfigSchema', () => {
  it('exposes every advertised tool by default', () => {
    expect(McpServerConfigSchema.parse({}).enabledTools).toEqual(['*']);
  });

  it('leaves transport unset so it can be inferred from command vs url', () => {
    expect(McpServerConfigSchema.parse({})).not.toHaveProperty('type');
  });

  it('rejects an unknown transport', () => {
    expect(McpServerConfigSchema.safeParse({ type: 'grpc' }).success).toBe(false);
  });

  it('requires the full triad when oauth is present', () => {
    expect(
      McpServerConfigSchema.safeParse({ url: 'https://x', oauth: { clientId: 'a' } }).success,
    ).toBe(false);
    expect(
      McpServerConfigSchema.safeParse({
        url: 'https://x',
        oauth: { authUrl: 'https://a', tokenUrl: 'https://t', clientId: 'c' },
      }).success,
    ).toBe(true);
  });
});

describe('ConfigPatchSchema', () => {
  it('accepts a single deeply nested field', () => {
    const patch = ConfigPatchSchema.parse({ agents: { defaults: { temperature: 0.5 } } });
    expect(patch.agents?.defaults?.temperature).toBe(0.5);
  });

  it('does not fill in defaults for absent sections', () => {
    // A patch must describe only what changed, or saving one settings panel
    // would rewrite every other section with its defaults.
    expect(ConfigPatchSchema.parse({})).toEqual({});
  });

  it('patches a nested block without its siblings', () => {
    const patch = ConfigPatchSchema.parse({ server: { auth: { enabled: false } } });
    expect(patch.server?.auth?.enabled).toBe(false);
    expect(patch.server).not.toHaveProperty('port');
  });

  it('still validates the fields it is given', () => {
    expect(ConfigPatchSchema.safeParse({ server: { port: -1 } }).success).toBe(false);
    expect(ConfigPatchSchema.safeParse({ tools: { approvals: { exec: 'nope' } } }).success).toBe(
      false,
    );
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '127.1.2.3', '127.255.255.255', 'localhost', 'LOCALHOST', '::1', '[::1]'])(
    'treats %s as loopback',
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(['0.0.0.0', '::', '', '192.168.1.10', '10.0.0.1', 'example.com', '128.0.0.1'])(
    'treats %s as remote',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  it('ignores surrounding whitespace', () => {
    expect(isLoopbackHost('  127.0.0.1 ')).toBe(true);
  });

  it('does not treat a host merely starting with 127 as loopback', () => {
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false);
    expect(isLoopbackHost('1270.0.0.1')).toBe(false);
  });
});
