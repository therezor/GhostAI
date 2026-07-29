import { AgentEntrySchema, ConfigPatchSchema } from '@ghostai/protocol';
import { describe, expect, it } from 'vitest';

import {
  parseToolList,
  toAgentDeletePatch,
  toAgentEntryForm,
  toAgentEntryPatch,
  toRenameAgentPatch,
  type AgentEntryForm,
} from './agents-form.js';

const EMPTY = AgentEntrySchema.parse({});

function form(overrides: Partial<AgentEntryForm> = {}): AgentEntryForm {
  return { ...toAgentEntryForm(EMPTY), ...overrides };
}

/** Every patch this form produces has to survive the schema the server applies. */
function parsed(result: ReturnType<typeof toAgentEntryPatch>): unknown {
  if (!result.ok) throw new Error(`expected a patch, got ${JSON.stringify(result.errors)}`);
  return ConfigPatchSchema.parse(result.patch).agents?.list?.reviewer;
}

describe('toAgentEntryForm', () => {
  it('shows an inherited field as empty rather than as a value', () => {
    // An empty box means "inherit". Rendering `0` or the default here would
    // make every new agent look like it had pinned every setting.
    const shown = toAgentEntryForm(EMPTY);

    expect(shown.model).toBe('');
    expect(shown.maxTokens).toBe('');
    expect(shown.temperature).toBe('');
    expect(shown.reasoningEffort).toBe('');
    expect(shown.toolTimeoutSeconds).toBe('');
  });

  it('shows the fields that belong to the agent itself', () => {
    const shown = toAgentEntryForm(
      AgentEntrySchema.parse({ label: 'Reviewer', systemPrompt: 'Be terse.' }),
    );

    expect(shown.label).toBe('Reviewer');
    expect(shown.systemPrompt).toBe('Be terse.');
    expect(shown.enabled).toBe(true);
  });

  it('shows an override as its value', () => {
    const shown = toAgentEntryForm(
      AgentEntrySchema.parse({ model: 'qwen3:32b', temperature: 0, toolTimeoutMs: 30_000 }),
    );

    expect(shown.model).toBe('qwen3:32b');
    // Zero is a value, not an absence — it must not render as an empty box.
    expect(shown.temperature).toBe('0');
    expect(shown.toolTimeoutSeconds).toBe('30');
  });

  it('renders tool lists as something a person can type', () => {
    const shown = toAgentEntryForm(
      AgentEntrySchema.parse({ tools: { allow: ['read_file', 'list_dir'], deny: ['exec'] } }),
    );

    expect(shown.allowTools).toBe('read_file, list_dir');
    expect(shown.denyTools).toBe('exec');
  });
});

describe('toAgentEntryPatch', () => {
  it('leaves an empty numeric box out of the patch entirely', () => {
    // Not an error and not a zero: the agent keeps inheriting.
    const entry = parsed(toAgentEntryPatch('reviewer', form()));

    expect(entry).not.toHaveProperty('maxTokens');
    expect(entry).not.toHaveProperty('temperature');
    expect(entry).not.toHaveProperty('reasoningEffort');
  });

  it('carries the overrides that were filled in', () => {
    const entry = parsed(
      toAgentEntryPatch(
        'reviewer',
        form({ model: 'qwen3:32b', temperature: '0', reasoningEffort: 'high' }),
      ),
    );

    expect(entry).toMatchObject({ model: 'qwen3:32b', temperature: 0, reasoningEffort: 'high' });
  });

  it('reports every bad field at once, not the first', () => {
    const result = toAgentEntryPatch(
      'reviewer',
      form({ maxTokens: 'lots', temperature: '9', contextWindowTokens: '-1' }),
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
    const result = toAgentEntryPatch('  ', form());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors.id).toBe('Required');
  });

  it('converts seconds to milliseconds, matching the defaults form', () => {
    const entry = parsed(toAgentEntryPatch('reviewer', form({ toolTimeoutSeconds: '45' })));
    expect(entry).toMatchObject({ toolTimeoutMs: 45_000 });
  });

  it('ignores a reasoning effort that is not one of the four', () => {
    const entry = parsed(toAgentEntryPatch('reviewer', form({ reasoningEffort: 'extreme' })));
    expect(entry).not.toHaveProperty('reasoningEffort');
  });

  it('sends only the approval bands that were set', () => {
    const entry = parsed(
      toAgentEntryPatch('reviewer', form({ approveExec: 'deny', approveNetwork: '' })),
    );

    expect(entry).toMatchObject({ approvals: { exec: 'deny' } });
    // The bands left blank keep the global policy, so they must not be sent.
    expect((entry as { approvals: Record<string, unknown> }).approvals).not.toHaveProperty(
      'network',
    );
  });

  it('omits approvals altogether when no band was set', () => {
    expect(parsed(toAgentEntryPatch('reviewer', form()))).not.toHaveProperty('approvals');
  });

  it('always sends the tool selection, so a restriction can be lifted', () => {
    // The merge replaces this object wholesale; omitting it would make
    // "clear this agent's tool restrictions" impossible to express.
    const entry = parsed(toAgentEntryPatch('reviewer', form({ allowTools: '', denyTools: '' })));
    expect(entry).toMatchObject({ tools: { allow: [], deny: [] } });
  });

  it('produces a patch the server’s own schema accepts', () => {
    const result = toAgentEntryPatch(
      'reviewer',
      form({ label: 'Reviewer', model: 'qwen3:32b', denyTools: 'exec' }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(ConfigPatchSchema.safeParse(result.patch).success).toBe(true);
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

describe('toRenameAgentPatch', () => {
  const entry = AgentEntrySchema.parse({
    label: 'Reviewer',
    systemPrompt: '# {{name}}\n\nOnly ever read.',
    model: 'qwen3:32b',
    tools: { allow: [], deny: ['exec'] },
    approvals: { exec: 'deny' },
  });

  it('carries the whole agent, because the patch replaces it wholesale', () => {
    // `agents.list.*` is in `REPLACE_WHOLESALE`, so a patch of `{ label }`
    // alone would not rename this agent — it would erase its prompt, its model
    // override, its tool selection and its approval policy, and leave a row
    // with the new name on it.
    const patch = toRenameAgentPatch('reviewer', 'Second Reader', entry);

    expect(patch.agents?.list?.reviewer).toMatchObject({
      label: 'Second Reader',
      systemPrompt: '# {{name}}\n\nOnly ever read.',
      model: 'qwen3:32b',
      tools: { deny: ['exec'] },
      approvals: { exec: 'deny' },
    });
    expect(ConfigPatchSchema.safeParse(patch).success).toBe(true);
  });

  it('trims the new name and leaves the id alone', () => {
    // The id is what a session's `agentId` points at; changing it on a rename
    // would orphan every conversation bound to this agent.
    const patch = toRenameAgentPatch('reviewer', '  Second Reader  ', entry);

    expect(Object.keys(patch.agents?.list ?? {})).toEqual(['reviewer']);
    expect(patch.agents?.list?.reviewer).toMatchObject({ label: 'Second Reader' });
  });
});
