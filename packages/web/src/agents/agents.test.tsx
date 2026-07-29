/**
 * The agents pages, driven through the real router.
 *
 * These cases moved here from `settings.test.tsx` when the Agent panel did:
 * the model and budget it edited *are* the default agent's, so they are tested
 * on the agent that owns them. What is asserted is unchanged — that the form
 * shows the config rather than the schema, that a save touches one subtree, and
 * that an invalid field is refused before it reaches the wire.
 *
 * The two additions are the ones the CRUD brought: the index lists an agent
 * that exists only by inheritance, and the default agent offers no delete.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConfigSchema, type ConfigPatch } from '@ghostai/protocol';

import { Providers } from '@/app/providers.js';
import { createAppRouter } from '@/app/router.js';
import { stubApi, testQueryClient, type RecordedRequest, type StubRoute } from '@/test/render.js';

const CONFIG = ConfigSchema.parse({
  agents: {
    defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 },
    list: { reviewer: { label: 'Reviewer', tools: { deny: ['exec'] } } },
  },
  providers: { ollama: { type: 'ollama' } },
});

const SETTINGS = { config: CONFIG, credentialsPresent: { ollama: false } };

const AGENTS = {
  agents: [
    { id: 'default', label: 'default', model: 'llama3', provider: 'ollama' },
    { id: 'reviewer', label: 'Reviewer', model: 'llama3', provider: 'ollama' },
  ],
};

const SHELL_ROUTES: Record<string, StubRoute> = {
  '/api/auth/me': [200, { username: 'ghost' }],
  '/api/setup': [200, { needed: false, hasPassword: true }],
  '/api/workspaces': [
    200,
    { workspaces: [{ id: 'default', name: 'Default', isDefault: true, sessionCount: 0 }] },
  ],
  '/api/status': [
    200,
    {
      version: '0.0.0',
      protocolVersion: 1,
      configured: true,
      workspaceId: 'default',
      workspaceCount: 1,
      uptimeMs: 1,
      model: 'llama3',
      provider: 'ollama',
      authEnabled: false,
      toolCount: 2,
      mcpServersConnected: 0,
      pluginsLoaded: 0,
    },
  ],
  '/api/sessions': [200, { sessions: [] }],
  '/api/notifications': [200, { notifications: [], unreadCount: 0 }],
};

function mount(
  path = '/agents',
  overrides: Record<string, StubRoute> = {},
): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly calls: RecordedRequest[];
} {
  const calls = stubApi({
    ...SHELL_ROUTES,
    '/api/settings': [200, SETTINGS],
    'PATCH /api/settings': [200, SETTINGS],
    '/api/agents': [200, AGENTS],
    '/api/providers': [200, { types: [], instances: [] }],
    '/api/models': [200, { models: [], errors: {} }],
    '/api/tools': [200, { tools: [] }],
    ...overrides,
  });

  const user = userEvent.setup();
  const router = createAppRouter();
  router.update({ history: createMemoryHistory({ initialEntries: [path] }) });
  render(
    <Providers client={testQueryClient()}>
      <RouterProvider router={router} />
    </Providers>,
  );

  return { user, calls };
}

const patchesOf = (calls: readonly RecordedRequest[]): ConfigPatch[] =>
  calls.filter((call) => call.method === 'PATCH').map((call) => call.body as ConfigPatch);

describe('the agents index', () => {
  it('lists the default even though nothing wrote it down', async () => {
    // Every unbound conversation runs on it, so a list of only the configured
    // agents would hide the one actually in use.
    mount();

    expect(await screen.findByRole('link', { name: 'Edit default' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit Reviewer' })).toBeInTheDocument();
  });

  it('says what an agent does without opening it', async () => {
    mount();

    expect(await screen.findByText('no exec')).toBeInTheDocument();
  });

  it('filters the list by name', async () => {
    const { user } = mount();

    await user.type(await screen.findByLabelText('Filter agents by name'), 'revi');

    expect(screen.getByRole('link', { name: 'Edit Reviewer' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit default' })).not.toBeInTheDocument();
  });

  it('says so rather than showing an empty table when nothing matches', async () => {
    const { user } = mount();

    await user.type(await screen.findByLabelText('Filter agents by name'), 'zzz');

    expect(screen.getByText(/No agent matches/)).toBeInTheDocument();
  });

  it('refuses a name that would collide with an agent already there', async () => {
    const { user, calls } = mount();

    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    await user.type(screen.getByLabelText('Name'), 'Reviewer');

    expect(screen.getByText(/already an agent called/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    expect(patchesOf(calls)).toHaveLength(0);
  });

  it('shows the id it would mint, before minting it', async () => {
    const { user } = mount();

    await user.click(await screen.findByRole('button', { name: 'New agent' }));
    await user.type(screen.getByLabelText('Name'), 'Code Reviewer');

    expect(screen.getByText(/Creates “code-reviewer”/)).toBeInTheDocument();
  });

  it('deletes from the row menu, and asks before it does', async () => {
    // It used to be possible only from the bottom of the editor, one navigation
    // away, with nothing between the button and the deletion.
    const { user, calls } = mount();

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

    expect(await screen.findByText(/fall back to the default agent/)).toBeVisible();
    expect(patchesOf(calls)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toContainEqual({ agents: { list: { reviewer: null } } });
    });
  });

  it('offers no delete for the default, which every unbound conversation runs on', async () => {
    const { user } = mount();

    await user.click(await screen.findByRole('button', { name: 'Actions for default' }));

    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();
  });

  it('renames without dropping everything else the agent holds', async () => {
    // `agents.list.*` is replaced wholesale, so a rename that sent only the
    // label would silently clear the tool selection beside it.
    const { user, calls } = mount();

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));

    const field = await screen.findByLabelText('Name');
    await user.clear(field);
    await user.type(field, 'Second Reader{Enter}');

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({
      label: 'Second Reader',
      tools: { deny: ['exec'] },
    });
  });

  it('sorts by a column, and keeps the default at the top either way', async () => {
    const { user } = mount();

    const firstRow = async (): Promise<string> => {
      const rows = await screen.findAllByRole('row');
      return rows[1]?.textContent ?? '';
    };

    expect(await firstRow()).toContain('default');

    await user.click(screen.getByRole('button', { name: 'Name' }));

    // Reversed, but the default is what the others inherit from rather than a
    // peer in the ordering.
    expect(await firstRow()).toContain('default');
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });
});

/**
 * Opens the Limits disclosure and returns the field inside it.
 *
 * The budget numbers moved behind a press because they are real settings that
 * nobody changes twice a year, and in the reading order they pushed the prompt
 * and the tools — the two things this screen is for — below the fold.
 */
async function limitsField(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Show limits' }));
  return await screen.findByLabelText(label);
}

describe('the default agent', () => {
  it('shows what the config says, not what the schema defaults to', async () => {
    const { user } = mount('/agents/default');

    expect(await limitsField(user, 'Max output tokens')).toHaveValue('4096');
  });

  it('keeps the budget out of the way until it is asked for', async () => {
    const { user } = mount('/agents/default');

    // The prompt and the tools are what this screen is for; five numbers above
    // them meant scrolling past a tuning panel to reach the subject.
    await screen.findByRole('button', { name: 'Show limits' });
    expect(screen.queryByLabelText('Max output tokens')).not.toBeInTheDocument();

    expect(await limitsField(user, 'Max output tokens')).toBeVisible();
  });

  it('offers no way to move the workspace directory', async () => {
    // Repointing the agent's filesystem root is the one setting in this app
    // that moves the sandbox, and a browser form is not where that decision
    // belongs. It stays configurable by file, environment and `--workspace`.
    const { user } = mount('/agents/default');

    await limitsField(user, 'Max output tokens');
    expect(screen.queryByLabelText('Workspace directory')).not.toBeInTheDocument();
  });

  it('labels an unset reasoning effort rather than rendering a blank control', async () => {
    // An empty `value` means *no* value to a Radix select, so the option would
    // select nothing and the trigger would render blank — a control that looks
    // broken while working perfectly.
    mount('/agents/default');

    expect(await screen.findByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent(
      'The provider’s own',
    );
  });

  it('says what an unset temperature means, in the control itself', async () => {
    // Unset is not zero: it means the request carries no temperature at all,
    // which is the only thing that works for a model that rejects it.
    mount('/agents/default');

    expect(await screen.findByLabelText('Temperature')).toHaveAttribute(
      'placeholder',
      'The provider’s own',
    );
  });

  it('saves the defaults subtree, and nothing outside agents', async () => {
    const { user, calls } = mount('/agents/default');

    const maxTokens = await limitsField(user, 'Max output tokens');
    await user.clear(maxTokens);
    await user.type(maxTokens, '2048');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });

    const [patch] = patchesOf(calls);
    expect(patch?.agents?.defaults?.maxTokens).toBe(2048);
    // The whole point of a deep-partial: the tool approvals this page never
    // showed must not be rewritten to their defaults by saving it.
    expect(Object.keys(patch ?? {})).toEqual(['agents']);
  });

  it('never sends a workspace, so a save cannot move the sandbox', async () => {
    // The field is gone from the form; this is the assertion that keeps it out
    // of the patch too. `agents.defaults` merges per field, so an omitted key
    // preserves a configured root — but an emitted `''` would reset it, and the
    // two are indistinguishable in a diff.
    const { user, calls } = mount('/agents/default');

    const maxTokens = await limitsField(user, 'Max output tokens');
    await user.clear(maxTokens);
    await user.type(maxTokens, '2048');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.defaults).not.toHaveProperty('workspace');
  });

  it('writes its own prompt to its entry and its model to the defaults', async () => {
    // The two halves of what the default agent is: `agents.defaults` is what
    // every other agent inherits, `agents.list.default` is its own behaviour.
    const { user, calls } = mount('/agents/default');

    const prompt = await screen.findByLabelText(/^System prompt for/);
    await user.clear(prompt);
    await user.type(prompt, 'Be terse.');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });

    const [patch] = patchesOf(calls);
    expect(patch?.agents?.list?.default).toMatchObject({ systemPrompt: 'Be terse.' });
    expect(patch?.agents?.defaults?.maxTokens).toBe(4096);
  });

  it('refuses to send a patch it knows is invalid, and says which field', async () => {
    const { user, calls } = mount('/agents/default');

    const temperature = await screen.findByLabelText('Temperature');
    await user.type(temperature, '9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Must be at most 2');
    expect(temperature).toHaveAttribute('aria-invalid', 'true');
    expect(patchesOf(calls)).toHaveLength(0);
  });

  it('reverts to what the server holds', async () => {
    const { user } = mount('/agents/default');

    const maxTokens = await limitsField(user, 'Max output tokens');
    await user.clear(maxTokens);
    await user.type(maxTokens, '10');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(maxTokens).toHaveValue('4096');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('offers no way to delete itself, and no way to switch itself off', async () => {
    // An install with no default agent is not a state anything downstream can
    // serve, so neither control exists rather than existing and refusing.
    const { user } = mount('/agents/default');

    await limitsField(user, 'Max output tokens');
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enabled')).not.toBeInTheDocument();
  });

  it('shows the built-in prompt rather than an empty box', async () => {
    // The discoverability half of "the prompt belongs to the agent": an
    // operator cannot choose to rewrite something they have never been shown,
    // and this box used to be empty on every install that had not customised it.
    mount('/agents/default');

    const prompt = await screen.findByLabelText(/^System prompt for/);
    expect((prompt as HTMLTextAreaElement).value).toContain('That directory is your root');
    expect(screen.getByText('The built-in prompt')).toBeInTheDocument();
  });
});

describe('choosing a provider', () => {
  /** Two endpoints with disjoint catalogues, and one that shares a model. */
  const TWO_PROVIDERS: Record<string, StubRoute> = {
    '/api/providers': [
      200,
      {
        types: [],
        instances: [
          {
            id: 'ollama',
            type: 'ollama',
            displayName: 'Ollama',
            apiBase: '',
            isLocal: true,
            isGateway: false,
            isOAuth: false,
            enabled: true,
            supportsModelListing: true,
            credentialsPresent: false,
          },
          {
            id: 'openai',
            type: 'openai',
            displayName: 'OpenAI',
            apiBase: '',
            isLocal: false,
            isGateway: false,
            isOAuth: false,
            enabled: true,
            supportsModelListing: true,
            credentialsPresent: true,
          },
        ],
      },
    ],
    '/api/models': [
      200,
      {
        models: [
          { id: 'llama3', providerId: 'ollama' },
          { id: 'shared-model', providerId: 'ollama' },
          { id: 'gpt-5', providerId: 'openai' },
          { id: 'shared-model', providerId: 'openai' },
        ],
        errors: {},
      },
    ],
  };

  /** Picks an option out of a Radix select by its accessible name. */
  async function choose(
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    option: RegExp,
  ): Promise<void> {
    await user.click(await screen.findByRole('combobox', { name: field }));
    await user.click(await screen.findByRole('option', { name: option }));
  }

  it('drops a pinned model the new provider cannot serve', async () => {
    // The list is per provider, and `modelOptions` deliberately keeps the
    // current value in it so a hand-typed model survives being looked at — so
    // without this a stale pin goes on *looking* valid right up until a turn
    // fails on it.
    const { user } = mount('/agents/default', TWO_PROVIDERS);

    await choose(user, 'Provider', /Ollama/);
    await choose(user, 'Model', /^llama3$/);
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('llama3');

    await choose(user, 'Provider', /OpenAI/);

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent(
      'Resolved automatically',
    );
  });

  it('keeps a model both providers offer', async () => {
    // Clearing unconditionally would throw away a valid choice, which is a
    // different way of being wrong about the same question.
    const { user } = mount('/agents/default', TWO_PROVIDERS);

    await choose(user, 'Provider', /Ollama/);
    await choose(user, 'Model', /^shared-model$/);

    await choose(user, 'Provider', /OpenAI/);

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('shared-model');
  });

  it('keeps the pin when the catalogue is empty, rather than unpinning on an outage', async () => {
    // An unreachable endpoint means "unknown", not "no". Clearing here would
    // silently unpin a working model because a server was briefly down.
    const { user } = mount('/agents/default', {
      ...TWO_PROVIDERS,
      '/api/models': [200, { models: [], errors: { ollama: 'connection refused' } }],
    });

    await screen.findByRole('combobox', { name: 'Model' });
    await choose(user, 'Provider', /OpenAI/);

    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('llama3');
  });
});

describe('a named agent', () => {
  it('says what it would inherit, rather than only implying it with grey text', async () => {
    // A placeholder relies on the reader already knowing that an empty box
    // means "inherited", which is the thing this screen used to fail to say.
    const { user } = mount('/agents/reviewer');

    expect(await screen.findByRole('combobox', { name: 'Model' })).toHaveTextContent(
      'Inherit — llama3',
    );

    const maxTokens = await limitsField(user, 'Max output tokens');
    expect(maxTokens).toHaveValue('');
    expect(screen.getByText('Empty inherits 4096 from the default agent.')).toBeInTheDocument();
  });

  it('saves only its own entry', async () => {
    const { user, calls } = mount('/agents/reviewer', {
      '/api/tools': [
        200,
        {
          tools: [
            { name: 'exec', description: '', risk: 'exec', parameters: {} },
            { name: 'write_file', description: '', risk: 'write', parameters: {} },
          ],
        },
      ],
    });

    // `exec` is already denied by the fixture, so switching `write_file` off
    // denies it too.
    await user.click(await screen.findByRole('switch', { name: 'write_file' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });

    const [patch] = patchesOf(calls);
    expect(patch?.agents?.list?.reviewer).toMatchObject({
      tools: { allow: [], deny: ['exec', 'write_file'] },
    });
    // The defaults are not touched by editing one agent.
    expect(patch?.agents).not.toHaveProperty('defaults');
  });

  it('keeps a denied tool this install does not have registered', async () => {
    // `agents.list.*` is replaced wholesale on save, so a checkbox list built
    // only from the live registry would silently drop the denial of a tool
    // whose MCP server happens to be down — and it would not come back.
    const { user, calls } = mount('/agents/reviewer', {
      '/api/tools': [
        200,
        { tools: [{ name: 'read_file', description: '', risk: 'safe', parameters: {} }] },
      ],
    });

    // `read_file` arrives with the tools query; `exec` is already on screen from
    // the stored deny list, so waiting for the slower one is what makes this
    // assert the union rather than a race.
    await user.click(await screen.findByRole('switch', { name: 'read_file' }));
    expect(screen.getByRole('switch', { name: 'exec' })).toBeInTheDocument();
    expect(screen.getByText('not installed')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({
      tools: { allow: [], deny: ['exec', 'read_file'] },
    });
  });

  it('can be deleted, unlike the default — and asks first', async () => {
    const { user, calls } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete this agent' }));

    // It used to fire straight from a button at the bottom of the form.
    expect(await screen.findByText(/fall back to the default agent/)).toBeVisible();
    expect(patchesOf(calls)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toBeNull();
  });

  it('owns its whole prompt, and can hand it back to the built-in', async () => {
    const { user, calls } = mount('/agents/reviewer', {
      '/api/settings': [
        200,
        {
          config: ConfigSchema.parse({
            agents: {
              defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 },
              list: { reviewer: { label: 'Reviewer', systemPrompt: '# Reviewer\n\nRead only.' } },
            },
          }),
          credentialsPresent: {},
        },
      ],
    });

    expect(await screen.findByLabelText(/^System prompt for/)).toHaveValue(
      '# Reviewer\n\nRead only.',
    );
    expect(screen.getByText('This agent’s own prompt')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Reset to the built-in/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    // Back to empty, which is what keeps it tracking improvements to the
    // built-in rather than freezing on today's copy of it.
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({ systemPrompt: '' });
  });

  it('warns about a placeholder nothing will fill', async () => {
    const { user } = mount('/agents/reviewer');

    const prompt = await screen.findByLabelText(/^System prompt for/);
    await user.clear(prompt);
    // Pasted rather than typed: `{{` is userEvent's own escape for a literal
    // brace, so `type` would deliver `{nmae}}` and quietly assert nothing.
    await user.click(prompt);
    await user.paste('You are {{nmae}}.');

    expect(await screen.findByRole('alert')).toHaveTextContent('{{nmae}}');
  });

  it('says so rather than silently creating one for a stale link', async () => {
    mount('/agents/deleted-last-week');

    expect(await screen.findByRole('alert')).toHaveTextContent('no agent called');
  });
});
