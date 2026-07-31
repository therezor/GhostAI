import { describe, expect, it } from 'vitest';

import {
  AgentDefaultsSchema,
  AgentEntrySchema,
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_AGENT_TOOLS,
  McpServerConfigSchema,
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
    expect(config.tools.approvalTimeoutMs).toBe(5 * 60 * 1000);
    expect(config.tools.web.search.provider).toBe('brave');
    expect(config.scheduler.concurrency).toBe(2);
    expect(config.scheduler.runRetention).toBe(200);
    // UTC, not the host zone: a server's own zone moves when the server does.
    expect(config.scheduler.timezone).toBe('UTC');
    expect(config.rag.rrfK).toBe(60);
    expect(config.channels.sendProgress).toBe(true);
    expect(config.plugins.allowUnverified).toBe(false);
  });

  it('keeps the scheduler block to the engine, with nothing describing a task', () => {
    // A heartbeat *is* a job: its interval is the job's schedule, its file and
    // model are the job's payload, its on/off is the job's own flag. This block
    // used to carry a `heartbeat` sub-block restating all of that — a second
    // vocabulary for one concept, and the one nothing read.
    const scheduler = ConfigSchema.parse({}).scheduler;

    expect(Object.keys(scheduler).sort()).toEqual([
      'catchUpOnBoot',
      'concurrency',
      'enabled',
      'runRetention',
      'timezone',
    ]);
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

  it('keys providers by instance id rather than a fixed field list', () => {
    const config = ConfigSchema.parse({
      providers: {
        laptop: { type: 'ollama', apiBase: 'http://localhost:11434' },
        anthropic: { type: 'anthropic' },
      },
    });
    expect(config.providers.laptop?.apiBase).toBe('http://localhost:11434');
    expect(config.providers.anthropic?.extraHeaders).toEqual({});
  });

  it('accepts two instances of one provider type', () => {
    // The shape this replaced was keyed by provider id, which capped the tree
    // at one endpoint per provider — two Ollama servers were inexpressible.
    const config = ConfigSchema.parse({
      providers: {
        ollama: { type: 'ollama' },
        'ollama-gpu': { type: 'ollama', label: 'GPU box', apiBase: 'http://gpu.lan:11434/v1' },
      },
    });
    expect(Object.keys(config.providers)).toEqual(['ollama', 'ollama-gpu']);
    expect(config.providers['ollama-gpu']?.label).toBe('GPU box');
    expect(config.providers.ollama?.enabled).toBe(true);
  });

  it('refuses an instance that does not name a type', () => {
    expect(ConfigSchema.safeParse({ providers: { ollama: {} } }).success).toBe(false);
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

describe('DEFAULT_AGENT_TOOLS', () => {
  it('asks before exec and allows reads and jailed writes', () => {
    expect(DEFAULT_AGENT_TOOLS).toMatchObject({
      read_file: 'allow',
      list_dir: 'allow',
      write_file: 'allow',
      edit_file: 'allow',
      exec: 'ask',
    });
  });

  it('cannot be mutated by whoever seeds an agent from it', () => {
    // Spread into every new entry, so a caller that pushed into it would change
    // what the *next* agent is created with.
    expect(Object.isFrozen(DEFAULT_AGENT_TOOLS)).toBe(true);
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

describe('AgentEntrySchema', () => {
  it('leaves every inherited field unset rather than defaulting it', () => {
    // An agent that defaulted `model` would pin itself to the empty string and
    // stop inheriting whatever `agents.defaults.model` later becomes.
    const agent = AgentEntrySchema.parse({});

    expect(agent).not.toHaveProperty('model');
    expect(agent).not.toHaveProperty('temperature');
    expect(agent).not.toHaveProperty('reasoningEffort');
  });

  it('defaults the fields that belong to the agent itself', () => {
    const agent = AgentEntrySchema.parse({});

    expect(agent.label).toBe('');
    expect(agent.systemPrompt).toBe('');
    expect(agent.enabled).toBe(true);
    expect(agent.tools).toEqual(DEFAULT_AGENT_TOOLS);
    expect(agent.toolbox).toEqual({
      name: '',
      network: { mode: 'none', allow: [] },
    });
    expect(agent.memory).toEqual({ shared: true });
  });

  it('does not let an agent pin its own workspace', () => {
    // The working folder is a session axis shared by every agent. Accepting it
    // here would let one agent quietly work somewhere else.
    const agent = AgentEntrySchema.parse({ workspace: '/tmp/elsewhere' });
    expect(agent).not.toHaveProperty('workspace');
  });

  it('keeps overrides it is given', () => {
    const agent = AgentEntrySchema.parse({
      label: 'Code Reviewer',
      model: 'claude-opus-5',
      temperature: 0,
      tools: { read_file: 'allow', exec: 'deny' },
    });

    expect(agent.model).toBe('claude-opus-5');
    expect(agent.temperature).toBe(0);
    expect(agent.tools).toEqual({ read_file: 'allow', exec: 'deny' });
  });

  it('seeds the built-in tools when an entry names none', () => {
    expect(AgentEntrySchema.parse({}).tools).toEqual(DEFAULT_AGENT_TOOLS);
  });

  it('replaces the seed rather than merging into it', () => {
    // The distinction the whole model rests on: an entry naming one tool has
    // one tool, or switching a seeded tool off would be inexpressible.
    const agent = AgentEntrySchema.parse({ tools: { read_file: 'allow' } });
    expect(agent.tools).toEqual({ read_file: 'allow' });
  });

  it('accepts an empty map as "nothing enabled"', () => {
    expect(AgentEntrySchema.parse({ tools: {} }).tools).toEqual({});
  });

  it('rejects an unknown permission', () => {
    expect(AgentEntrySchema.safeParse({ tools: { exec: 'maybe' } }).success).toBe(false);
  });

  it('still validates an inherited field it is given', () => {
    expect(AgentEntrySchema.safeParse({ temperature: 9 }).success).toBe(false);
    expect(AgentEntrySchema.safeParse({ reasoningEffort: 'nope' }).success).toBe(false);
  });
});

describe('AgentsConfigSchema', () => {
  it('starts with no named agents', () => {
    const agents = ConfigSchema.parse({}).agents;
    expect(agents.list).toEqual({});
    expect(agents.defaults.provider).toBe('auto');
  });

  it('keeps the scheduler block to the engine, with nothing describing a task', () => {
    // A heartbeat *is* a job: its interval is the job's schedule, its file and
    // model are the job's payload, its on/off is the job's own flag. This block
    // used to carry a `heartbeat` sub-block restating all of that — a second
    // vocabulary for one concept, and the one nothing read.
    const scheduler = ConfigSchema.parse({}).scheduler;

    expect(Object.keys(scheduler).sort()).toEqual([
      'catchUpOnBoot',
      'concurrency',
      'enabled',
      'runRetention',
      'timezone',
    ]);
  });

  it('does not share mutable defaults between parses', () => {
    const one = AgentEntrySchema.parse({});
    const two = AgentEntrySchema.parse({});

    expect(one.tools).not.toBe(two.tools);
    expect(one.toolbox).not.toBe(two.toolbox);
  });

  it('keys agents by an id the operator chooses', () => {
    const agents = ConfigSchema.parse({
      agents: { list: { reviewer: { label: 'Reviewer' }, writer: {} } },
    }).agents;

    expect(Object.keys(agents.list)).toEqual(['reviewer', 'writer']);
    expect(agents.list.reviewer?.label).toBe('Reviewer');
  });
});

describe('ConfigPatchSchema', () => {
  it('accepts a null to delete a named agent', () => {
    const patch = ConfigPatchSchema.parse({ agents: { list: { reviewer: null } } });
    expect(patch.agents?.list?.reviewer).toBeNull();
  });

  it('patches one agent without restating the others or its own siblings', () => {
    const patch = ConfigPatchSchema.parse({ agents: { list: { reviewer: { temperature: 0 } } } });

    expect(patch.agents?.list?.reviewer?.temperature).toBe(0);
    expect(patch.agents?.list?.reviewer).not.toHaveProperty('label');
    expect(patch.agents).not.toHaveProperty('defaults');
  });

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
    expect(
      ConfigPatchSchema.safeParse({ agents: { list: { a: { tools: { exec: 'nope' } } } } }).success,
    ).toBe(false);
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

describe('ConfigPatchSchema: the toolbox', () => {
  it('accepts a network patch that changes only the mode', () => {
    // `patchOf` is not recursive, so without the hand-restated `network` this
    // would demand `allow` back — and a panel that never rendered the allow-list
    // would clear it on every save of the mode.
    const patch = ConfigPatchSchema.parse({
      agents: { list: { boxed: { toolbox: { network: { mode: 'open' } } } } },
    });

    expect(patch.agents?.list?.boxed?.toolbox?.network).toEqual({ mode: 'open' });
  });

  it('accepts a toolbox patch that names only the box', () => {
    const patch = ConfigPatchSchema.parse({
      agents: { list: { boxed: { toolbox: { name: 'kali-pentest' } } } },
    });

    expect(patch.agents?.list?.boxed?.toolbox?.name).toBe('kali-pentest');
    expect(patch.agents?.list?.boxed?.toolbox?.network).toBeUndefined();
  });
});
