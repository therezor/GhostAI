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
  profileId: undefined,
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
