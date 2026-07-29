import { describe, expect, it } from 'vitest';

import { toolOutputTag } from '@ghostai/security';

import {
  SECTION_SEPARATOR,
  buildRuntimeBlock,
  buildStaticPrompt,
  composeSystemPrompt,
  type ContextContributor,
  type RuntimePromptContext,
  type StaticPromptContext,
} from './prompt.js';

const CONTEXT: StaticPromptContext = {
  workspaceRoot: '/home/u/.ghostai/workspace',
  workspaceId: 'default',
  sessionKey: 'web:1',
  agentId: undefined,
  channel: 'cli',
};

const RUNTIME: RuntimePromptContext = {
  ...CONTEXT,
  iteration: 3,
  maxIterations: 40,
  nowMs: 1_700_000_000_000,
};

describe('buildStaticPrompt', () => {
  it('names the workspace and states that paths resolve into it', async () => {
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });

    expect(prompt).toContain('/home/u/.ghostai/workspace');
    expect(prompt).toContain('`default` workspace');
    expect(prompt).toContain('That directory is your root');
  });

  it('states the exec exception, because the two layers disagree on purpose', async () => {
    // The file tools resolve an outside path inside the workspace; exec refuses
    // it, since the child runs on the real filesystem. A model told only the
    // first rule reads the second one's error as a malfunction.
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });

    expect(prompt).toContain('`exec` is the exception');
    expect(prompt).toContain('confined to the workspace');
  });

  it('names the workspace the session is bound to, not always the default', async () => {
    const prompt = await buildStaticPrompt({
      context: { ...CONTEXT, workspaceId: 'client-acme' },
      platform: 'linux',
    });

    expect(prompt).toContain('`client-acme` workspace');
  });

  it('carries nothing that changes during a session', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      runtimeLabel: 'Linux x64, Node 22.11.0',
    });

    // The whole value of the split is that this half is a stable cache prefix.
    // A timestamp, an iteration counter or the turn's nonce reaching it would
    // invalidate the session's cached prefix on every request.
    expect(prompt).not.toContain('Current time');
    expect(prompt).not.toContain('Agent iteration');
    expect(prompt).not.toContain('tool_output_');
  });

  it('is byte-identical across calls with the same context', async () => {
    const options = { context: CONTEXT, platform: 'linux' as const };

    expect(await buildStaticPrompt(options)).toBe(await buildStaticPrompt(options));
  });

  it('gives Windows its own platform policy', async () => {
    const posix = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });
    const windows = await buildStaticPrompt({ context: CONTEXT, platform: 'win32' });

    expect(posix).toContain('Platform policy (POSIX)');
    expect(windows).toContain('Platform policy (Windows)');
    expect(windows).toContain('grep');
  });

  it('names the host in the runtime line', async () => {
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'darwin' });

    expect(prompt).toMatch(/macOS \w+, Node /);
  });

  it('falls back to the raw platform name for anything unrecognised', async () => {
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'freebsd' });

    expect(prompt).toContain('freebsd');
  });

  it('appends contributor sections after the built-in ones', async () => {
    const memory: ContextContributor = {
      name: 'memory',
      staticSection: () => Promise.resolve('# Memory\n\nThe user prefers metric units.'),
    };
    const skills: ContextContributor = { name: 'skills', staticSection: () => '# Skills\n\npdf' };

    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      contributors: [memory, skills],
    });

    expect(prompt.indexOf('# GhostAI')).toBeLessThan(prompt.indexOf('# Memory'));
    expect(prompt.indexOf('# Memory')).toBeLessThan(prompt.indexOf('# Skills'));
    expect(prompt.split(SECTION_SEPARATOR)).toHaveLength(3);
  });

  it('keeps the built-in identity when no agent is named', async () => {
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });

    expect(prompt).toContain('# GhostAI');
    expect(prompt).toContain('You are GhostAI, a self-hosted agent');
    expect(prompt).not.toContain('## Instructions');
  });

  it("takes a named agent's label as the identity", async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      agent: { label: 'Code Reviewer', systemPrompt: '' },
    });

    expect(prompt).toContain('# Code Reviewer');
    expect(prompt).toContain('You are Code Reviewer, a self-hosted agent');
    expect(prompt).not.toContain('GhostAI');
  });

  it('falls back to GhostAI for an agent with no label', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      agent: { label: '', systemPrompt: '' },
    });

    expect(prompt).toContain('# GhostAI');
  });

  it('uses the built-in template for an agent that stores no prompt of its own', async () => {
    // Empty means "the built-in", which is what keeps an install that never
    // customised a prompt receiving improvements to it on upgrade.
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'win32',
      agent: { label: 'Reviewer', systemPrompt: '' },
    });

    expect(prompt).toContain('That directory is your root');
    expect(prompt).toContain('`exec` is the exception');
    expect(prompt).toContain('## Platform policy (Windows)');
    expect(prompt).toContain('## Guidelines');
  });

  it("replaces the whole identity with the agent's own prompt", async () => {
    // The decision this file was reorganised around: a stored prompt *is* the
    // static half, not an `## Instructions` section appended below a fixed one.
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      agent: { label: 'Reviewer', systemPrompt: '# {{name}}\n\nOnly ever read. Never write.' },
    });

    expect(prompt).toContain('# Reviewer');
    expect(prompt).toContain('Only ever read. Never write.');
    // None of the built-in text survives — that is what "fully editable" means.
    expect(prompt).not.toContain('That directory is your root');
    expect(prompt).not.toContain('## Guidelines');
    expect(prompt).not.toContain('## Instructions');
  });

  it('fills every placeholder a stored prompt names', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'win32',
      runtimeLabel: 'Windows x64, Node 22.0.0',
      agent: {
        label: 'Reviewer',
        systemPrompt:
          '{{name}} | {{workspaceId}} | {{workspaceRoot}} | {{runtime}}\n\n{{platformPolicy}}',
      },
    });

    expect(prompt).toContain(
      `Reviewer | ${CONTEXT.workspaceId} | ${CONTEXT.workspaceRoot} | Windows x64, Node 22.0.0`,
    );
    expect(prompt).toContain('## Platform policy (Windows)');
  });

  it('treats a whitespace-only prompt as no prompt at all', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      agent: { label: 'Reviewer', systemPrompt: '   \n  ' },
    });

    // Not an agent with an empty identity — a template of three newlines is not
    // a decision anybody made, so the built-in stands.
    expect(prompt).toContain('# Reviewer');
    expect(prompt).toContain('## Guidelines');
    expect(prompt.split(SECTION_SEPARATOR)).toHaveLength(1);
  });

  it("puts the agent's identity before anything a contributor adds", async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      agent: { label: 'Reviewer', systemPrompt: '# {{name}}\n\nOnly ever read.' },
      contributors: [{ name: 'memory', staticSection: () => '# Memory\n\nmetric units' }],
    });

    expect(prompt.indexOf('# Reviewer')).toBeLessThan(prompt.indexOf('# Memory'));
    expect(prompt.split(SECTION_SEPARATOR)).toHaveLength(2);
  });

  it('is still byte-identical across calls, so the cached prefix holds', async () => {
    const agent = { label: 'Reviewer', systemPrompt: 'Be terse.' };
    const first = await buildStaticPrompt({ context: CONTEXT, platform: 'linux', agent });
    const second = await buildStaticPrompt({ context: CONTEXT, platform: 'linux', agent });

    expect(first).toBe(second);
  });

  it('skips a contributor with nothing to say', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      contributors: [
        { name: 'empty', staticSection: () => '   ' },
        { name: 'absent', staticSection: () => undefined },
        { name: 'silent' },
      ],
    });

    expect(prompt.split(SECTION_SEPARATOR)).toHaveLength(1);
  });
});

describe('buildRuntimeBlock', () => {
  it('reports live state and the turn in progress', () => {
    const block = buildRuntimeBlock({
      context: RUNTIME,
      nonce: 'a1b2c3d4e5f60718',
      timeZone: 'Europe/Madrid',
    });

    expect(block).toContain('## Live state');
    expect(block).toContain(
      'Current time: 2023-11-14T22:13:20.000Z (host time zone: Europe/Madrid)',
    );
    expect(block).toContain('Channel: cli');
    expect(block).toContain('Session: web:1');
    expect(block).toContain('Agent iteration: 3 / 40');
  });

  it('names this turn’s delimiter in the tool-output policy', () => {
    const block = buildRuntimeBlock({ context: RUNTIME, nonce: 'a1b2c3d4e5f60718' });

    expect(block).toContain(toolOutputTag('a1b2c3d4e5f60718'));
    expect(block).toContain('## Tool output policy');
  });

  it('defaults the time zone to the host', () => {
    const block = buildRuntimeBlock({ context: RUNTIME, nonce: 'a1b2c3d4e5f60718' });

    expect(block).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('includes contributor sections and skips empty ones', () => {
    const block = buildRuntimeBlock({
      context: RUNTIME,
      nonce: 'a1b2c3d4e5f60718',
      contributors: [
        { name: 'kb', runtimeSection: (context) => `Active knowledge base: ${context.sessionKey}` },
        { name: 'quiet', runtimeSection: () => '' },
        { name: 'silent' },
      ],
    });

    expect(block).toContain('Active knowledge base: web:1');
    // Live state, the one contributor, and the policy — nothing for the others.
    expect(block.split('\n\n##')).toHaveLength(2);
  });
});

describe('composeSystemPrompt', () => {
  it('puts the stable half first, so the volatile half only invalidates itself', () => {
    expect(composeSystemPrompt('STATIC', 'RUNTIME')).toBe(`STATIC${SECTION_SEPARATOR}RUNTIME`);
  });
});
