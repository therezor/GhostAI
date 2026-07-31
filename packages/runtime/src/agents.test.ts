import { isGhostError } from '@ghostai/core';
import {
  ConfigSchema,
  DEFAULT_AGENT_TOOLS,
  type Config,
  type ConfigPatch,
} from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { hasAgent, listAgents, resolveAgent } from './agents.js';
import { mergeConfigPatch } from './merge.js';

const base = ConfigSchema.parse({});

/** Through the real merge, so the tests exercise the shape a save produces. */
function configWith(patch: ConfigPatch): Config {
  return mergeConfigPatch(base, patch);
}

describe('resolveAgent', () => {
  it('resolves the default agent on an install that has defined none', () => {
    const agent = resolveAgent(base, undefined);

    expect(agent.id).toBe('default');
    expect(agent.label).toBe('default');
    expect(agent.systemPrompt).toBe('');
    expect(agent.defaults).toEqual(base.agents.defaults);
    expect(agent.toolsConfig).toEqual(base.tools);
    expect(agent.tools).toEqual(DEFAULT_AGENT_TOOLS);
  });

  it('treats an empty id as the default, the way an unbound session does', () => {
    expect(resolveAgent(base, '').id).toBe('default');
  });

  it('inherits every field the entry does not name', () => {
    const config = configWith({
      agents: { list: { reviewer: { label: 'Reviewer', temperature: 0 } } },
    });
    const agent = resolveAgent(config, 'reviewer');

    expect(agent.defaults.temperature).toBe(0);
    expect(agent.defaults.model).toBe(base.agents.defaults.model);
    expect(agent.defaults.maxTokens).toBe(base.agents.defaults.maxTokens);
    expect(agent.defaults.provider).toBe(base.agents.defaults.provider);
  });

  it("takes the agent's override over the default, field by field", () => {
    const config = configWith({
      agents: {
        defaults: { model: 'qwen3:8b', temperature: 0.7, maxTokens: 4096 },
        list: { reviewer: { model: 'claude-opus-5', reasoningEffort: 'high' } },
      },
    });
    const agent = resolveAgent(config, 'reviewer');

    expect(agent.defaults.model).toBe('claude-opus-5');
    expect(agent.defaults.reasoningEffort).toBe('high');
    // Untouched by the entry, so still the defaults'.
    expect(agent.defaults.temperature).toBe(0.7);
    expect(agent.defaults.maxTokens).toBe(4096);
  });

  it('carries an override for a field that has no default at all', () => {
    // `reasoningEffort` and `consolidationModel` are optional with no default,
    // so they are absent from a parsed `agents.defaults`. A merge driven by the
    // keys that happen to be present would drop exactly these two.
    const config = configWith({
      agents: { list: { reviewer: { reasoningEffort: 'high', consolidationModel: 'haiku' } } },
    });
    const agent = resolveAgent(config, 'reviewer');

    expect(agent.defaults.reasoningEffort).toBe('high');
    expect(agent.defaults.consolidationModel).toBe('haiku');
    // And the default agent still has neither.
    expect(resolveAgent(config, undefined).defaults.reasoningEffort).toBeUndefined();
  });

  it('never lets an agent move its own workspace', () => {
    const config = configWith({
      agents: { defaults: { workspace: '/tmp/shared' }, list: { reviewer: {} } },
    });

    expect(resolveAgent(config, 'reviewer').defaults.workspace).toBe('/tmp/shared');
  });

  it('replaces the tool map rather than merging into the seed', () => {
    // The one field that does not inherit per key. A merge could add a tool and
    // change a permission but never remove one, and switching a tool off has to
    // be expressible.
    const config = configWith({
      agents: { list: { reviewer: { tools: { read_file: 'allow', exec: 'deny' } } } },
    });

    expect(resolveAgent(config, 'reviewer').tools).toEqual({
      read_file: 'allow',
      exec: 'deny',
    });
  });

  it('seeds the built-ins for an agent that names no tools', () => {
    const config = configWith({ agents: { list: { reviewer: {} } } });

    expect(resolveAgent(config, 'reviewer').tools).toEqual(DEFAULT_AGENT_TOOLS);
  });

  it('seeds the default agent, which usually has no entry at all', () => {
    // An agent with no tools cannot do anything, and `default` is the agent an
    // install that configured nothing runs as.
    expect(resolveAgent(configWith({}), undefined).tools).toEqual(DEFAULT_AGENT_TOOLS);
  });

  it('lets an agent hold no tools at all when it says so', () => {
    const config = configWith({ agents: { list: { reviewer: { tools: {} } } } });

    expect(resolveAgent(config, 'reviewer').tools).toEqual({});
  });

  it('merges the exec guard so one agent can hold a tighter allow-list', () => {
    const config = configWith({
      agents: { list: { reviewer: { exec: { allowedBinaries: ['git'] } } } },
    });
    const agent = resolveAgent(config, 'reviewer');

    expect(agent.toolsConfig.exec.allowedBinaries).toEqual(['git']);
    expect(agent.toolsConfig.exec.envAllowlist).toEqual(base.tools.exec.envAllowlist);
    // And the global config is untouched — this is a view, not a mutation.
    expect(base.tools.exec.allowedBinaries).toEqual([]);
  });

  it('falls back to the id when no label was given', () => {
    const config = configWith({ agents: { list: { reviewer: {} } } });
    expect(resolveAgent(config, 'reviewer').label).toBe('reviewer');
  });

  it('lets agents.list.default customise the agent an install already runs as', () => {
    const config = configWith({
      agents: { list: { default: { label: 'Ghost', systemPrompt: 'Be terse.' } } },
    });
    const agent = resolveAgent(config, undefined);

    expect(agent.label).toBe('Ghost');
    expect(agent.systemPrompt).toBe('Be terse.');
  });

  it('refuses an unknown id, naming what does exist', () => {
    const config = configWith({ agents: { list: { reviewer: {} } } });

    expect(() => resolveAgent(config, 'nope')).toThrow(/No agent named "nope"/);
    expect(() => resolveAgent(config, 'nope')).toThrow(/default, reviewer/);
  });

  it('refuses a disabled agent, and says that is why', () => {
    const config = configWith({ agents: { list: { reviewer: { enabled: false } } } });

    expect(() => resolveAgent(config, 'reviewer')).toThrow(/disabled/);
  });

  it('refuses toolbox networking on an agent that names none', () => {
    // Resolution runs inside an all-or-nothing rebuild, so this is a 400 on the
    // save rather than a turn that dies minutes later. Egress scoping is
    // enforced by the sandbox, so asking for it on the host means nothing — and
    // an option that silently does nothing is worse than one that is refused.
    const config = configWith({
      agents: { list: { boxed: { toolbox: { network: { mode: 'open' } } } } },
    });

    const error = (() => {
      try {
        resolveAgent(config, 'boxed');
        return null;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(isGhostError(error) && error.kind).toBe('config');
    expect(() => resolveAgent(config, 'boxed')).toThrow(/names no toolbox/);
  });

  it('refuses an egress entry that is not a CIDR block', () => {
    // A hostname allow-list is defeated by DNS rebinding, which is the attack
    // `guardedFetch` already exists to stop.
    const config = configWith({
      agents: {
        list: {
          boxed: {
            toolbox: { name: 'kali', network: { mode: 'allowlist', allow: ['example.com'] } },
          },
        },
      },
    });

    expect(() => resolveAgent(config, 'boxed')).toThrow(/CIDR/);
  });

  it('resolves an agent naming a toolbox with a scoped allow-list', () => {
    const config = configWith({
      agents: {
        list: {
          boxed: {
            toolbox: {
              name: 'kali-pentest',
              network: { mode: 'allowlist', allow: ['192.168.1.0/24'] },
            },
          },
        },
      },
    });

    const agent = resolveAgent(config, 'boxed');
    expect(agent.toolbox.name).toBe('kali-pentest');
    expect(agent.toolbox.network.allow).toEqual(['192.168.1.0/24']);
  });

  it('defaults an agent with no toolbox entry to the host', () => {
    const config = configWith({ agents: { list: { plain: {} } } });

    expect(resolveAgent(config, 'plain').toolbox.name).toBe('');
    expect(resolveAgent(config, 'plain').toolbox.network.mode).toBe('none');
  });
});

describe('listAgents', () => {
  it('lists the default alone on a bare install', () => {
    expect(listAgents(base).map((agent) => agent.id)).toEqual(['default']);
  });

  it('puts the default first, then the operator’s order', () => {
    const config = configWith({
      agents: { list: { writer: {}, reviewer: {} } },
    });

    expect(listAgents(config).map((agent) => agent.id)).toEqual(['default', 'writer', 'reviewer']);
  });

  it('omits a disabled agent without duplicating the default', () => {
    const config = configWith({
      agents: { list: { default: { label: 'Ghost' }, writer: { enabled: false }, reviewer: {} } },
    });

    expect(listAgents(config).map((agent) => agent.id)).toEqual(['default', 'reviewer']);
    expect(listAgents(config)[0]?.label).toBe('Ghost');
  });

  it('keeps the default runnable even if it is marked disabled', () => {
    // Switching off the only agent an install has is not a state anything
    // above here can do something useful with.
    const config = configWith({ agents: { list: { default: { enabled: false } } } });

    expect(listAgents(config).map((agent) => agent.id)).toEqual(['default']);
    expect(resolveAgent(config, 'default').id).toBe('default');
  });
});

describe('hasAgent', () => {
  it('always knows the default', () => {
    expect(hasAgent(base, 'default')).toBe(true);
  });

  it.each([
    ['an unknown id', 'nope', false],
    ['an enabled agent', 'reviewer', true],
    ['a disabled agent', 'writer', false],
  ])('reports %s as %s', (_name, id, expected) => {
    const config = configWith({
      agents: { list: { reviewer: {}, writer: { enabled: false } } },
    });

    expect(hasAgent(config, id)).toBe(expected);
  });
});

describe('subagents', () => {
  /** A config with `main` delegating to whatever the refs name. */
  const delegating = (refs: readonly { id: string; prompt?: string }[]): ConfigPatch => ({
    agents: {
      list: {
        researcher: { label: 'Researcher' },
        // `permission` is spelled out because `ConfigPatch` is the schema's
        // *output* type: the protocol keeps input and output identical, so a
        // defaulted field is still required of a TypeScript literal.
        main: {
          label: 'Main',
          subagents: refs.map((ref) => ({ prompt: '', permission: 'allow' as const, ...ref })),
        },
      },
    },
  });

  it('resolves a ref into the binding the loop is built with', () => {
    const agent = resolveAgent(
      configWith(delegating([{ id: 'researcher', prompt: 'Ask for facts.' }])),
      'main',
    );

    expect(agent.subagents).toEqual([
      {
        // Derived, so two subagents cannot collide and none can shadow a
        // built-in — no built-in name starts with the prefix.
        toolName: 'ask_researcher',
        agentId: 'researcher',
        // Read off the target's entry, so renaming that agent is one edit.
        label: 'Researcher',
        prompt: 'Ask for facts.',
        permission: 'allow',
      },
    ]);
  });

  it('turns a hyphenated id into a legal tool name', () => {
    const config = configWith({
      agents: {
        list: {
          'code-review': { label: 'Code review' },
          main: { subagents: [{ id: 'code-review', prompt: '', permission: 'allow' }] },
        },
      },
    });

    expect(resolveAgent(config, 'main').subagents[0]?.toolName).toBe('ask_code_review');
  });

  it('is empty for an agent that delegates to nobody', () => {
    expect(resolveAgent(base, undefined).subagents).toEqual([]);
  });

  it('lets an agent delegate to `default`, which usually has no entry', () => {
    const config = configWith({
      agents: {
        list: { main: { subagents: [{ id: 'default', prompt: '', permission: 'allow' }] } },
      },
    });

    expect(resolveAgent(config, 'main').subagents[0]).toMatchObject({
      agentId: 'default',
      label: 'default',
    });
  });

  it('refuses an agent that lists itself', () => {
    const config = configWith({
      agents: { list: { main: { subagents: [{ id: 'main', prompt: '', permission: 'allow' }] } } },
    });

    expect(() => resolveAgent(config, 'main')).toThrow(/lists itself as a subagent/);
    try {
      resolveAgent(config, 'main');
    } catch (error) {
      // A `config` error, which is what makes a bad save a 400 that changes
      // nothing rather than a turn that dies later.
      expect(isGhostError(error) && error.kind).toBe('config');
    }
  });

  it('refuses the same subagent twice', () => {
    const config = configWith(delegating([{ id: 'researcher' }, { id: 'researcher' }]));

    expect(() => resolveAgent(config, 'main')).toThrow(/lists "researcher" as a subagent twice/);
  });

  it('refuses a subagent that does not exist, and says what does', () => {
    const config = configWith(delegating([{ id: 'nobody' }]));

    expect(() => resolveAgent(config, 'main')).toThrow(/does not exist: "nobody"/);
    expect(() => resolveAgent(config, 'main')).toThrow(/Known agents: researcher, main/);
  });

  it('refuses a disabled subagent, which is a different mistake', () => {
    const config = configWith({
      agents: {
        list: {
          researcher: { label: 'Researcher', enabled: false },
          main: { subagents: [{ id: 'researcher', prompt: '', permission: 'allow' }] },
        },
      },
    });

    expect(() => resolveAgent(config, 'main')).toThrow(/that agent is disabled/);
  });

  it('refuses at listing too, not only when the agent is asked for', () => {
    // `listAgents` builds every entry, so a save that introduces a bad ref
    // fails the whole reconfigure rather than the first turn that uses it.
    const config = configWith(delegating([{ id: 'nobody' }]));

    expect(() => listAgents(config)).toThrow(/does not exist/);
  });
});
