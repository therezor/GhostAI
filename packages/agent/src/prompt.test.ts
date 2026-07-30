import { describe, expect, it } from 'vitest';

import { toolOutputTag } from '@ghostai/security';

import {
  SECTION_SEPARATOR,
  buildRuntimeBlock,
  buildStaticPrompt,
  composeSystemPrompt,
  type ContextContributor,
  type PromptToolbox,
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

/** Long enough for `toolOutputTag`, which refuses a short one. */
const NONCE = 'a1b2c3d4e5f60718';

const TOOLBOX: PromptToolbox = {
  name: 'web-research',
  workdir: '/workspace',
  tools: [{ name: 'search', use: 'Search the web.' }],
  notes: 'Run `tools` for the full reference.',
};

describe('buildStaticPrompt', () => {
  it('names the workspace by id, and withholds its absolute path', async () => {
    // The path is the one thing the file tools exist to hide, and a model handed
    // it uses it: `<root>/notes/x` was resolved *into* the workspace again,
    // landing on `<root>/home/u/.ghostai/workspace/notes/x` with no error. It is
    // also the only line in the prompt that told a provider the operator's home
    // directory layout.
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });

    expect(prompt).toContain('`default` workspace');
    expect(prompt).toContain('To the file tools it is the');
    expect(prompt).not.toContain(CONTEXT.workspaceRoot);
  });

  it('states the exec exception, because the two layers disagree on purpose', async () => {
    // The file tools resolve an outside path inside the workspace; exec refuses
    // it, since the child runs on the real filesystem. A model told only the
    // first rule reads the second one's error as a malfunction.
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });

    expect(prompt).toContain('`exec` runs on this machine');
    expect(prompt).toContain('*not* confined to the workspace');
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

  it('gives Windows its own shell advice', async () => {
    const posix = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });
    const windows = await buildStaticPrompt({ context: CONTEXT, platform: 'win32' });

    expect(posix).toContain('Standard shell tools and UTF-8 are available');
    expect(windows).toContain('Do not assume GNU tools');
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

    expect(prompt).toContain('To the file tools it is the');
    expect(prompt).toContain('`exec` runs on this machine');
    expect(prompt).toContain('Do not assume GNU tools');
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

    // `workspaceRoot` and `runtime` are still filled for a prompt that asks —
    // the default declines them, this is not a removal.
    expect(prompt).toContain(
      `Reviewer | ${CONTEXT.workspaceId} | ${CONTEXT.workspaceRoot} | Windows x64, Node 22.0.0`,
    );
    expect(prompt).toContain('## Running commands');
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

/**
 * The half of the prompt that depends on *where* `exec` lands.
 *
 * Untested until now, and it was wrong in four places for a toolboxed agent: it
 * named the host OS as the command environment, claimed commands were not
 * confined to the workspace when only the workspace is mounted, and on a Windows
 * host warned that GNU tools might be missing from a Linux container that has
 * them. A model resolving a contradiction between its prompt and its tools tends
 * to resolve it by refusing.
 */
describe('buildStaticPrompt: with a toolbox', () => {
  it('says commands run in the container, not on the host it names', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'darwin',
      runtimeLabel: 'macOS arm64, Node 22.0.0',
      toolbox: TOOLBOX,
    });

    expect(prompt).toContain('This machine runs macOS arm64, Node 22.0.0');
    expect(prompt).toContain('Your `exec` calls do not: they run inside the');
    expect(prompt).toContain('`web-research` toolbox container');
    // The host wording, which would be a direct contradiction of the above.
    expect(prompt).not.toContain('`exec` runs on this machine');
    expect(prompt).not.toContain('*not* confined to the workspace');
  });

  it('keeps the file tools on this machine, and maps the two names for one file', async () => {
    // The sentence a model has no other way to arrive at: the file it wrote and
    // the file a command sees are the same file, addressed differently.
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      toolbox: TOOLBOX,
    });

    expect(prompt).toContain('they always act on the workspace here, never inside the container');
    expect(prompt).toContain('`notes/todo.md` is `/workspace/notes/todo.md` to a command');
  });

  it('does not warn a Windows host about tools the container has', async () => {
    // The container is Linux whatever the host is, so the Windows advice is not
    // merely unhelpful here — it is false about the machine the command runs on.
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'win32',
      toolbox: TOOLBOX,
    });

    expect(prompt).not.toContain('Do not assume GNU tools');
  });

  it('leaves the toolbox section to say only what is specific to the box', async () => {
    // It used to open by stating where commands run, which `commandPolicy` now
    // says earlier and for both placements.
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      toolbox: TOOLBOX,
    });

    expect(prompt).toContain('## Toolbox: web-research');
    expect(prompt).toContain('A shell is available in here');
    expect(prompt).toContain('- `search` — Search the web.');
    expect(prompt).toContain('Run `tools` for the full reference.');
    expect(prompt).not.toContain('run inside this container, not on this machine');
  });

  it('includes the toolbox reference, because a model does not go looking for it', async () => {
    // The failure: `TOOLS.md` lived inside the image, reachable only by the model
    // choosing to run `tools`. It did not — it answered a research question from
    // search snippets with the section explaining how to read pages one command
    // away. Discoverable is not read.
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      toolbox: { ...TOOLBOX, docs: '## search\n\nReading is the default.' },
    });

    expect(prompt).toContain('### web-research reference');
    expect(prompt).toContain('Reading is the default.');
    // After the installed list, not instead of it: the list is what a model scans,
    // the reference is what it consults.
    expect(prompt.indexOf('- `search`')).toBeLessThan(prompt.indexOf('Reading is the default.'));
  });

  it('renders no reference heading for a toolbox without one', async () => {
    const prompt = await buildStaticPrompt({
      context: CONTEXT,
      platform: 'linux',
      toolbox: TOOLBOX,
    });

    // The heading specifically: the fixture's `notes` mention the word, and an
    // assertion on the bare word would pass for the wrong reason.
    expect(prompt).toContain('## Toolbox: web-research');
    expect(prompt).not.toContain('### web-research reference');
  });

  it('keeps the reference in the cached half', async () => {
    // A few thousand tokens re-sent on every iteration of every turn would undo
    // the split this file exists for. Two builds of the same session are
    // byte-identical, which is what a provider's prefix cache requires.
    const options = {
      context: CONTEXT,
      platform: 'linux' as const,
      toolbox: { ...TOOLBOX, docs: 'the reference' },
    };

    expect(await buildStaticPrompt(options)).toBe(await buildStaticPrompt(options));
  });

  it('renders the host wording when there is no toolbox', async () => {
    const prompt = await buildStaticPrompt({ context: CONTEXT, platform: 'linux' });

    expect(prompt).toContain('`exec` runs on this machine');
    expect(prompt).not.toContain('## Toolbox');
  });
});

describe('buildRuntimeBlock', () => {
  it('gives the time locally and as an instant, and nothing else', () => {
    const block = buildRuntimeBlock({
      context: RUNTIME,
      nonce: 'a1b2c3d4e5f60718',
      timeZone: 'Europe/Madrid',
    });

    expect(block).toContain('## Live state');
    // The local reading, for what "this afternoon" means, with the weekday for
    // "this weekend" — and the ISO instant, because local time is ambiguous.
    expect(block).toContain('Tuesday, 14 November 2023 at 23:13 (Europe/Madrid)');
    expect(block).toContain('2023-11-14T22:13:20Z');
    // Milliseconds are gone: no question has ever turned on them.
    expect(block).not.toContain('.000Z');
  });

  it('carries no channel, session key or iteration counter', () => {
    // All three were printed on every request of every turn, in the *uncached*
    // half, and nothing in the prompt said what any of them meant. The session
    // key is a UUID the model cannot use and might echo at the user.
    const block = buildRuntimeBlock({
      context: RUNTIME,
      nonce: 'a1b2c3d4e5f60718',
      timeZone: 'Europe/Madrid',
    });

    expect(block).not.toContain('Channel:');
    expect(block).not.toContain('Session:');
    expect(block).not.toContain('web:1');
    expect(block).not.toContain('Agent iteration');
  });

  it('says nothing about iterations until they are nearly gone', () => {
    // At 3 of 40 the count is a fact with no consequence. The cost of saying it
    // anyway is paid on every request, because this half is never cached.
    const early = buildRuntimeBlock({ context: RUNTIME, nonce: NONCE, timeZone: 'UTC' });

    expect(early).not.toMatch(/iterations left/);
  });

  it('tells the model to wrap up when the cap is close', () => {
    const late = buildRuntimeBlock({
      context: { ...RUNTIME, iteration: 38, maxIterations: 40 },
      nonce: NONCE,
      timeZone: 'UTC',
    });

    expect(late).toContain('Tool iterations left in this turn: 3');
    expect(late).toContain('answer with what you have');
  });

  it('says it is the last one on the final iteration', () => {
    // Counted inclusively: on the last legal iteration one is left, not none.
    const last = buildRuntimeBlock({
      context: { ...RUNTIME, iteration: 40, maxIterations: 40 },
      nonce: NONCE,
      timeZone: 'UTC',
    });

    expect(last).toContain('Tool iterations left in this turn: 1');
  });

  it('lets an operator replace the wording entirely', () => {
    // The point of the templates. Prompt text an install runs on should be text
    // an operator can read and edit, not text compiled into the binary — the same
    // decision `systemPrompt` already made for the identity half.
    const block = buildRuntimeBlock({
      context: RUNTIME,
      nonce: NONCE,
      timeZone: 'UTC',
      livePrompt: '## Ahora\n\nSon las {{time}} en la sesión {{sessionKey}}.',
    });

    expect(block).toContain('## Ahora');
    expect(block).toContain('Son las Tuesday, 14 November 2023');
    // `sessionKey` and `channel` are offered even though the default declines
    // them, so an operator who disagrees can put them back without patching us.
    expect(block).toContain('web:1');
  });

  it('lets an operator reword the wrap-up sentence', () => {
    const block = buildRuntimeBlock({
      context: { ...RUNTIME, iteration: 39, maxIterations: 40 },
      nonce: NONCE,
      timeZone: 'UTC',
      wrapUpPrompt: '\n\nOnly {{iterationsLeft}} left — stop and summarise.',
    });

    expect(block).toContain('Only 2 left — stop and summarise.');
    expect(block).not.toContain('Wrap up');
  });

  it('treats a single space as removing the section, and empty as “use the default”', () => {
    // The asymmetry matters: empty has to keep inheriting improvements to the
    // built-in, so it cannot also be the way to say "I want this gone".
    const silenced = buildRuntimeBlock({
      context: RUNTIME,
      nonce: NONCE,
      timeZone: 'UTC',
      livePrompt: ' ',
    });
    const defaulted = buildRuntimeBlock({
      context: RUNTIME,
      nonce: NONCE,
      timeZone: 'UTC',
      livePrompt: '',
    });

    expect(silenced).not.toContain('## Live state');
    // And the rest of the block survives: the tool-output policy is not the
    // operator's to remove, since it is the injection defence rather than prose.
    expect(silenced).toContain(toolOutputTag(NONCE));
    expect(defaulted).toContain('## Live state');
  });

  it('falls back to UTC rather than throwing on an unknown zone', () => {
    // `Intl` throws for a zone it does not know, and a prompt that fails to build
    // fails every turn on that agent.
    const block = buildRuntimeBlock({
      context: RUNTIME,
      nonce: NONCE,
      timeZone: 'Mars/Olympus_Mons',
    });

    expect(block).toContain('2023-11-14T22:13:20Z');
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
