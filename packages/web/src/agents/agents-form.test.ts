import {
  AgentDefaultsSchema,
  AgentEntrySchema,
  ConfigPatchSchema,
  type AgentDefaults,
  type AgentEntry,
} from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import { createWebI18n } from '@ghostai/i18n/web';

/** English, resolved: these assertions compare the message a user would read. */
const t = createWebI18n('en').getFixedT(null, 'web');

import {
  MODEL_REQUIRED,
  parseToolList,
  toAgentDeletePatch,
  toAgentEnabledPatch,
  toAgentEntryForm,
  toAgentEntryPatch,
  toDefaultAgentPatch,
  toNewAgentPatch,
  toAgentForm,
  type AgentEntryForm,
} from './agents-form.js';

const EMPTY = AgentEntrySchema.parse({});

const DEFAULTS: AgentDefaults = AgentDefaultsSchema.parse({
  provider: 'ollama',
  model: 'llama3',
  maxTokens: 4096,
  toolTimeoutMs: 20_000,
});

function form(overrides: Partial<AgentEntryForm> = {}): AgentEntryForm {
  return { ...toAgentEntryForm(EMPTY, DEFAULTS), ...overrides };
}

/** Every patch this form produces has to survive the schema the server applies. */
function parsed(result: ReturnType<typeof toAgentEntryPatch>): unknown {
  if (!result.ok) throw new Error(`expected a patch, got ${JSON.stringify(result.errors)}`);
  return ConfigPatchSchema.parse(result.patch).agents?.list?.reviewer;
}

describe('toAgentEntryForm', () => {
  it('fills a field the agent stored none of from the defaults', () => {
    // Nothing on this screen inherits, so a blank box would be a claim that the
    // agent runs on no model and no budget — which is not what a turn would do.
    const shown = toAgentEntryForm(EMPTY, DEFAULTS);

    expect(shown.provider).toBe('ollama');
    expect(shown.model).toBe('llama3');
    expect(shown.maxTokens).toBe('4096');
    expect(shown.toolTimeoutSeconds).toBe('20');
  });

  it('leaves genuinely unset settings unset, rather than inventing values', () => {
    // Neither has a default: unset means the request carries no such parameter,
    // which is the only thing that works for a model that rejects it.
    const shown = toAgentEntryForm(EMPTY, DEFAULTS);

    expect(shown.temperature).toBe('');
    expect(shown.reasoningEffort).toBe('');
  });

  it('shows the fields that belong to the agent itself', () => {
    const shown = toAgentEntryForm(
      AgentEntrySchema.parse({ label: 'Reviewer', systemPrompt: 'Be terse.' }),
      DEFAULTS,
    );

    expect(shown.label).toBe('Reviewer');
    expect(shown.systemPrompt).toBe('Be terse.');
    expect(shown.enabled).toBe(true);
  });

  it('prefers what the agent stored over what the defaults say', () => {
    const shown = toAgentEntryForm(
      AgentEntrySchema.parse({ model: 'qwen3:32b', temperature: 0, toolTimeoutMs: 30_000 }),
      DEFAULTS,
    );

    expect(shown.model).toBe('qwen3:32b');
    // Zero is a value, not an absence — it must not fall through to the default.
    expect(shown.temperature).toBe('0');
    expect(shown.toolTimeoutSeconds).toBe('30');
  });

  it('renders tool lists as something a person can type', () => {
    const shown = toAgentEntryForm(
      AgentEntrySchema.parse({ tools: { allow: ['read_file', 'list_dir'], deny: ['exec'] } }),
      DEFAULTS,
    );

    expect(shown.allowTools).toBe('read_file, list_dir');
    expect(shown.denyTools).toBe('exec');
  });
});

describe('toAgentEntryPatch', () => {
  it('writes the settings down, so the agent stops depending on the defaults', () => {
    // The form was filled from `agents.defaults`; the point of saving it is
    // that a later change to those defaults no longer moves this agent.
    const entry = parsed(toAgentEntryPatch('reviewer', form(), EMPTY, t));

    expect(entry).toMatchObject({
      provider: 'ollama',
      model: 'llama3',
      maxTokens: 4096,
      toolTimeoutMs: 20_000,
    });
  });

  it('leaves temperature and reasoning effort out when they are blank', () => {
    // The two that can genuinely be unset. Omitting the key is what clears it,
    // because `agents.list.*` is replaced wholesale.
    const entry = parsed(toAgentEntryPatch('reviewer', form(), EMPTY, t));

    expect(entry).not.toHaveProperty('temperature');
    expect(entry).not.toHaveProperty('reasoningEffort');
  });

  it('refuses a required box the operator emptied', () => {
    // It arrived holding a number. A blank one is a deletion, not an unset —
    // and there is nothing left for it to fall through to.
    const result = toAgentEntryPatch('reviewer', form({ maxTokens: '' }), EMPTY, t);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.maxTokens).toBe('Required');
  });

  it('carries the values that were filled in', () => {
    const entry = parsed(
      toAgentEntryPatch(
        'reviewer',
        form({ model: 'qwen3:32b', temperature: '0', reasoningEffort: 'high' }),
        EMPTY,
        t,
      ),
    );

    expect(entry).toMatchObject({ model: 'qwen3:32b', temperature: 0, reasoningEffort: 'high' });
  });

  it('keeps the settings this screen does not render', () => {
    // `agents.list.*` is replaced wholesale, so an entry rebuilt from the form
    // alone would drop the sandbox and the exec allow-list every time the
    // prompt was saved — silently, and with no way to notice from the screen.
    const stored = AgentEntrySchema.parse({
      sandbox: { kind: 'docker', image: 'ghost:latest' },
      exec: { allowedBinaries: ['git'] },
    });

    const entry = parsed(toAgentEntryPatch('reviewer', form(), stored, t));

    expect(entry).toMatchObject({
      sandbox: { kind: 'docker', image: 'ghost:latest' },
      exec: { allowedBinaries: ['git'] },
    });
  });

  it('reports every bad field at once, not the first', () => {
    const result = toAgentEntryPatch(
      'reviewer',
      form({ maxTokens: 'lots', temperature: '9', contextWindowTokens: '-1' }),
      EMPTY,
      t,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(Object.keys(result.errors).sort()).toEqual([
      'contextWindowTokens',
      'maxTokens',
      'temperature',
    ]);
  });

  it('refuses an empty id', () => {
    const result = toAgentEntryPatch('  ', form(), EMPTY, t);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.id).toBe('Required');
  });

  it('refuses an empty provider, which would resolve to nothing', () => {
    const result = toAgentEntryPatch('reviewer', form({ provider: '  ' }), EMPTY, t);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.provider).toBe('Required');
  });

  it('refuses an empty model, which is an agent that cannot run', () => {
    // This used to be saved as a value, on the reading that an empty model asks
    // the registry to resolve one. It does not: `Runtime#resolveProvider` turns
    // an empty model into `noModelError` and hands the loop a `null` provider,
    // so what the form was writing down was an agent with no way to take a turn.
    const result = toAgentEntryPatch('reviewer', form({ model: '  ' }), EMPTY, t);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.model).toBe(MODEL_REQUIRED);
  });

  it('converts seconds to milliseconds, matching the defaults form', () => {
    const entry = parsed(
      toAgentEntryPatch('reviewer', form({ toolTimeoutSeconds: '45' }), EMPTY, t),
    );
    expect(entry).toMatchObject({ toolTimeoutMs: 45_000 });
  });

  it('ignores a reasoning effort that is not one of the four', () => {
    const entry = parsed(
      toAgentEntryPatch('reviewer', form({ reasoningEffort: 'extreme' }), EMPTY, t),
    );
    expect(entry).not.toHaveProperty('reasoningEffort');
  });

  it('sends only the approval bands that were set', () => {
    const entry = parsed(
      toAgentEntryPatch('reviewer', form({ approveExec: 'deny', approveNetwork: '' }), EMPTY, t),
    );

    expect(entry).toMatchObject({ approvals: { exec: 'deny' } });
    // The bands left blank keep the global policy, so they must not be sent.
    expect((entry as { approvals: Record<string, unknown> }).approvals).not.toHaveProperty(
      'network',
    );
  });

  it('omits approvals altogether when no band was set', () => {
    expect(parsed(toAgentEntryPatch('reviewer', form(), EMPTY, t))).not.toHaveProperty('approvals');
  });

  it('clears a stored approval the operator blanked', () => {
    // The stored entry is carried through wholesale, so a band dropped from it
    // has to be dropped explicitly or blanking one would do nothing at all.
    const stored = AgentEntrySchema.parse({ approvals: { exec: 'deny' } });
    const entry = parsed(toAgentEntryPatch('reviewer', form({ approveExec: '' }), stored, t));

    expect(entry).not.toHaveProperty('approvals');
  });

  it('always sends the tool selection, so a restriction can be lifted', () => {
    // The merge replaces this object wholesale; omitting it would make
    // "clear this agent's tool restrictions" impossible to express.
    const entry = parsed(
      toAgentEntryPatch('reviewer', form({ allowTools: '', denyTools: '' }), EMPTY, t),
    );
    expect(entry).toMatchObject({ tools: { allow: [], deny: [] } });
  });

  it('produces a patch the server’s own schema accepts', () => {
    const result = toAgentEntryPatch(
      'reviewer',
      form({ label: 'Reviewer', model: 'qwen3:32b', denyTools: 'exec' }),
      EMPTY,
      t,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(ConfigPatchSchema.safeParse(result.patch).success).toBe(true);
  });
});

describe('toDefaultAgentPatch', () => {
  it('writes the model and budget to the defaults, and nothing else there', () => {
    const result = toDefaultAgentPatch(toAgentForm(DEFAULTS), form(), EMPTY, t);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.patch.agents?.defaults).toMatchObject({ model: 'llama3', maxTokens: 4096 });
  });

  it('never pins the default agent against its own defaults', () => {
    // Its entry holds the prompt and the permissions; the model and the budget
    // are `agents.defaults`. An override here would be a contradiction, and one
    // that would silently stop the Model section on this screen from working.
    const result = toDefaultAgentPatch(toAgentForm(DEFAULTS), form(), EMPTY, t);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const own = result.patch.agents?.list?.default;
    expect(own).not.toHaveProperty('model');
    expect(own).not.toHaveProperty('provider');
    expect(own).not.toHaveProperty('maxTokens');
    expect(own).not.toHaveProperty('toolTimeoutMs');
    expect(ConfigPatchSchema.safeParse(result.patch).success).toBe(true);
  });

  it('reports the defaults’ own errors rather than saving half of it', () => {
    const result = toDefaultAgentPatch(
      { ...toAgentForm(DEFAULTS), maxTokens: '' },
      form(),
      EMPTY,
      t,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.maxTokens).toBe('Required');
  });
});

describe('toNewAgentPatch', () => {
  const template: AgentEntry = AgentEntrySchema.parse({
    systemPrompt: 'House style: be terse.',
    tools: { allow: [], deny: ['exec'] },
  });

  it('copies the model and budget the template would have run on', () => {
    // The default agent's entry stores neither — they are `agents.defaults` —
    // so a copy that took only what was written down would produce an agent
    // holding nothing, on a screen that no longer inherits.
    const patch = toNewAgentPatch('reviewer', 'Reviewer', template, DEFAULTS);

    expect(patch.agents?.list?.reviewer).toMatchObject({
      label: 'Reviewer',
      enabled: true,
      provider: 'ollama',
      model: 'llama3',
      maxTokens: 4096,
      toolTimeoutMs: 20_000,
    });
  });

  it('copies how the template behaves as well as what it runs on', () => {
    const patch = toNewAgentPatch('reviewer', 'Reviewer', template, DEFAULTS);

    expect(patch.agents?.list?.reviewer).toMatchObject({
      systemPrompt: 'House style: be terse.',
      tools: { deny: ['exec'] },
    });
    expect(ConfigPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('takes the template’s own value over the default where it has one', () => {
    const pinned = AgentEntrySchema.parse({ model: 'qwen3:32b', maxTokens: 512 });
    const patch = toNewAgentPatch('copy', 'Copy', pinned, DEFAULTS);

    expect(patch.agents?.list?.copy).toMatchObject({ model: 'qwen3:32b', maxTokens: 512 });
  });
});

describe('toAgentEnabledPatch', () => {
  const entry = AgentEntrySchema.parse({
    label: 'Reviewer',
    systemPrompt: 'Only ever read.',
    tools: { allow: [], deny: ['exec'] },
  });

  it('carries the whole agent, because the patch replaces it wholesale', () => {
    // `{ enabled: false }` alone would switch the agent off by deleting its
    // prompt and its tool selection — so switching it back on would return an
    // empty agent wearing the same name.
    const patch = toAgentEnabledPatch('reviewer', entry, false);

    expect(patch.agents?.list?.reviewer).toMatchObject({
      enabled: false,
      systemPrompt: 'Only ever read.',
      tools: { deny: ['exec'] },
    });
    expect(ConfigPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('switches one back on', () => {
    const off = AgentEntrySchema.parse({ label: 'Reviewer', enabled: false });
    expect(toAgentEnabledPatch('reviewer', off, true).agents?.list?.reviewer).toMatchObject({
      enabled: true,
    });
  });
});

describe('parseToolList', () => {
  it.each([
    ['', []],
    ['exec', ['exec']],
    ['a, b ,  c', ['a', 'b', 'c']],
    ['a, , b', ['a', 'b']],
    ['  ', []],
  ])('parses %j', (value, expected) => {
    expect(parseToolList(value)).toEqual(expected);
  });
});

describe('toAgentDeletePatch', () => {
  it('uses the null the merge reads as a deletion', () => {
    const patch = toAgentDeletePatch('reviewer');

    expect(patch).toEqual({ agents: { list: { reviewer: null } } });
    expect(ConfigPatchSchema.safeParse(patch).success).toBe(true);
  });
});
