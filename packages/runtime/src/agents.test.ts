import { isGhostError } from '@ghostai/core';
import { ConfigSchema, type Config, type ConfigPatch } from '@ghostai/protocol';
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
    expect(agent.tools).toEqual({ allow: [], deny: [] });
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

  it('merges approvals band by band rather than replacing the table', () => {
    const config = configWith({
      agents: { list: { reviewer: { approvals: { exec: 'deny' } } } },
    });
    const agent = resolveAgent(config, 'reviewer');

    expect(agent.toolsConfig.approvals.exec).toBe('deny');
    // The bands the agent said nothing about keep the global policy.
    expect(agent.toolsConfig.approvals.write).toBe(base.tools.approvals.write);
    expect(agent.toolsConfig.approvals.network).toBe(base.tools.approvals.network);
    expect(agent.toolsConfig.approvals.timeoutMs).toBe(base.tools.approvals.timeoutMs);
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

  it('refuses the docker sandbox while it has no backend', () => {
    // Resolution runs inside an all-or-nothing rebuild, so this is a 400 on the
    // save rather than a turn that dies minutes later.
    const config = configWith({
      agents: { list: { boxed: { sandbox: { kind: 'docker', image: 'node:22' } } } },
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
    expect(() => resolveAgent(config, 'boxed')).toThrow(/not implemented yet/);
  });

  it('still resolves an agent that asked for the host sandbox explicitly', () => {
    const config = configWith({
      agents: { list: { plain: { sandbox: { kind: 'host' } } } },
    });

    expect(resolveAgent(config, 'plain').sandbox.kind).toBe('host');
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
