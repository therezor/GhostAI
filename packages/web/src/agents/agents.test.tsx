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
 *
 * What is no longer asserted anywhere is inheritance *on the screen*. The
 * config format still allows an absent field to fall through to
 * `agents.defaults`, and `@ghostai/runtime` has the cases for it — but the
 * editor fills every box from the defaults and writes them down, so the
 * assertions here are that an agent shows its own settings rather than a blank
 * where somebody else's would have been used.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConfigSchema, defaultSubagentPrompt, type ConfigPatch } from '@ghostai/protocol';

import { Providers } from '@/app/providers.js';
import { createAppRouter } from '@/app/router.js';
import { stubApi, testQueryClient, type RecordedRequest, type StubRoute } from '@/test/render.js';
import { STATUS } from '@/test/fixtures.js';

const CONFIG = ConfigSchema.parse({
  agents: {
    defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 },
    list: {
      reviewer: {
        label: 'Reviewer',
        tools: { read_file: 'allow', list_dir: 'allow', exec: 'deny' },
      },
    },
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
  '/api/status': [200, { ...STATUS, model: 'llama3', toolCount: 2 }],
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

/**
 * Settings routes that remember what was written to them.
 *
 * The flat stub answers every GET with the original config, which is fine for
 * the cases that only assert what went over the wire — and wrong for the ones
 * about what the screen does *after* a write, because the test client runs with
 * `gcTime: 0`, so navigating away drops the settings query and the next screen
 * refetches. Against a static stub that refetch undoes the save, and the case
 * fails for a reason the product does not have.
 *
 * Shallow over `agents.list` is all these cases need; the real merge is
 * `@ghostai/runtime`'s to prove, and `merge.test.ts` does.
 */
function statefulSettings(base = CONFIG): Record<string, StubRoute> {
  let current = base;

  const respond = (): [number, unknown] => [
    200,
    { config: current, credentialsPresent: { ollama: false } },
  ];

  return {
    '/api/settings': respond,
    'PATCH /api/settings': (request) => {
      const patch = request.body as ConfigPatch;
      const written = Object.entries(patch.agents?.list ?? {});
      // `null` is the deletion token, so those ids are filtered out of the
      // result rather than written into it.
      const removed = new Set(written.filter(([, entry]) => entry === null).map(([id]) => id));
      const list = Object.fromEntries(
        [...Object.entries(current.agents.list), ...written].filter(([id]) => !removed.has(id)),
      );
      current = ConfigSchema.parse({ ...current, agents: { ...current.agents, list } });
      return respond();
    },
  };
}

/**
 * Sets one tool's permission through its row's select.
 *
 * The whole control, in one call: the tool list is one row per tool with one
 * combobox on it, so there is no switch to press first and no mode to be in.
 */
async function pick(
  user: ReturnType<typeof userEvent.setup>,
  tool: string,
  permission: string,
): Promise<void> {
  await user.click(await screen.findByRole('combobox', { name: `Permission for ${tool}` }));
  await user.click(await screen.findByRole('option', { name: permission }));
}

/**
 * The index's rows, in the order they are painted.
 *
 * Scoped to the named list rather than swept off the document: a page can hold
 * more than one `<ul>`, and an open kebab menu is one of them.
 */
async function agentRows(): Promise<readonly HTMLElement[]> {
  return within(await screen.findByRole('list', { name: 'Agents' })).getAllByRole('listitem');
}

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

    // Counts, not names: every agent's map holds the same five tools, so
    // listing them would print the same words on every row.
    expect(await screen.findByText(/2 tools/)).toBeInTheDocument();
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

  it('offers no delete for the default, and no way to switch it off', async () => {
    // Neither is a state anything downstream can serve: an install with no
    // default agent is one where an unbound conversation cannot run at all.
    const { user } = mount();

    await user.click(await screen.findByRole('button', { name: 'Actions for default' }));

    expect(await screen.findByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('says whether each agent is on, in a word on the row', async () => {
    // It used to be an `off` badge beside the name and nothing at all when the
    // agent was on — which reads as "no comment" rather than as "this runs".
    mount('/agents', {
      '/api/settings': [
        200,
        {
          config: ConfigSchema.parse({
            agents: {
              defaults: { model: 'llama3', provider: 'ollama' },
              list: { reviewer: { label: 'Reviewer', enabled: false } },
            },
          }),
          credentialsPresent: {},
        },
      ],
    });

    const row = (await screen.findByRole('link', { name: 'Edit Reviewer' })).closest('li');
    expect(row).toHaveTextContent('Disabled');
    expect(
      (await screen.findByRole('link', { name: 'Edit default' })).closest('li'),
    ).toHaveTextContent('Enabled');
  });

  it('switches an agent off from the row menu, keeping everything it holds', async () => {
    // The reversible half of Delete: `agents.list.*` is replaced wholesale, so
    // a patch of `{ enabled: false }` alone would disable the agent by erasing
    // its tool permissions — and switching it back on would return an empty one.
    const { user, calls } = mount();

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({
      enabled: false,
      tools: { read_file: 'allow', list_dir: 'allow', exec: 'deny' },
    });
  });

  it('offers Enable on one that is already off', async () => {
    const { user } = mount('/agents', {
      '/api/settings': [
        200,
        {
          config: ConfigSchema.parse({
            agents: { list: { reviewer: { label: 'Reviewer', enabled: false } } },
          }),
          credentialsPresent: {},
        },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));

    expect(await screen.findByRole('menuitem', { name: 'Enable' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Disable' })).not.toBeInTheDocument();
  });

  it('sorts by status, and still keeps the default at the top', async () => {
    const { user } = mount();

    await user.click(await screen.findByRole('button', { name: /Sort by/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Status' }));

    expect((await agentRows())[0]?.textContent).toContain('default');
    expect(screen.getByRole('button', { name: /Sort by Status/ })).toBeInTheDocument();
  });

  it('offers no Rename, because the name is a field in the editor', async () => {
    // A second way to edit one field, with its own dialog and its own patch
    // builder, was a shortcut that had to be kept correct twice.
    const { user } = mount();

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));

    expect(await screen.findByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).not.toBeInTheDocument();
  });

  it('opens the copy of the default in its editor, not on a stale link', async () => {
    // The duplicate bug: `save` is fire-and-forget, and navigating on the next
    // line took the editor to an agent the settings cache had never seen — so
    // duplicating the default landed on "There is no agent called …" and read
    // as a menu item that did nothing.
    const { user, calls } = mount('/agents', statefulSettings());

    await user.click(await screen.findByRole('button', { name: 'Actions for default' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.['default-copy']).toMatchObject({
      label: 'default copy',
      // Prepopulated from the defaults, since the default agent's own entry
      // holds neither: this is the copy actually being a copy.
      model: 'llama3',
      maxTokens: 4096,
    });

    expect(await screen.findByRole('heading', { name: 'default copy' })).toBeInTheDocument();
    expect(screen.queryByText(/no agent called/)).not.toBeInTheDocument();
  });

  it('does not silently do nothing when the obvious copy name is taken', async () => {
    // `Reviewer copy` exists, so the next one has to be `Reviewer copy 2`. It
    // used to return early and leave the operator pressing a dead menu item.
    const { user, calls } = mount('/agents', {
      '/api/settings': [
        200,
        {
          config: ConfigSchema.parse({
            agents: {
              defaults: { model: 'llama3', provider: 'ollama' },
              list: {
                reviewer: { label: 'Reviewer' },
                'reviewer-copy': { label: 'Reviewer copy' },
              },
            },
          }),
          credentialsPresent: {},
        },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Actions for Reviewer' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.['reviewer-copy-2']).toMatchObject({
      label: 'Reviewer copy 2',
    });
  });

  it('sorts by a column, and keeps the default at the top either way', async () => {
    const { user } = mount();

    const firstRow = async (): Promise<string> => (await agentRows())[0]?.textContent ?? '';

    expect(await firstRow()).toContain('default');

    await user.click(await screen.findByRole('button', { name: /Sort by/ }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Descending' }));

    // Reversed, but the default is the one the others were created from rather
    // than a peer in the ordering.
    expect(await firstRow()).toContain('default');
    expect(screen.getByRole('button', { name: /Descending/ })).toBeInTheDocument();
  });
});

describe('the default agent', () => {
  it('shows what the config says, not what the schema defaults to', async () => {
    mount('/agents/default');

    expect(await screen.findByLabelText('Max output tokens')).toHaveValue('4096');
  });

  it('shows the budget without making it be asked for', async () => {
    // It sat behind a "Show limits" press while the numbers were inherited and
    // a blank box was the normal state. They are this agent's own now, and a
    // setting an operator has to go looking for to read is not one they can be
    // said to have chosen.
    mount('/agents/default');

    expect(await screen.findByLabelText('Max output tokens')).toBeVisible();
    expect(screen.queryByRole('button', { name: /limits/i })).not.toBeInTheDocument();
  });

  it('offers no way to move the workspace directory', async () => {
    // Repointing the agent's filesystem root is the one setting in this app
    // that moves the sandbox, and a browser form is not where that decision
    // belongs. It stays configurable by file, environment and `--workspace`.
    mount('/agents/default');

    await screen.findByLabelText('Max output tokens');
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

    const maxTokens = await screen.findByLabelText('Max output tokens');
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

    const maxTokens = await screen.findByLabelText('Max output tokens');
    await user.clear(maxTokens);
    await user.type(maxTokens, '2048');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.defaults).not.toHaveProperty('workspace');
  });

  it('writes its own prompt to its entry and its model to the defaults', async () => {
    // The two halves of what the default agent is: `agents.defaults` is what a
    // new agent is seeded from, `agents.list.default` is its own behaviour.
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

    const maxTokens = await screen.findByLabelText('Max output tokens');
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
    mount('/agents/default');

    await screen.findByLabelText('Max output tokens');
    expect(screen.queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enabled')).not.toBeInTheDocument();
  });

  it('shows the built-in prompt rather than an empty box', async () => {
    // The discoverability half of "the prompt belongs to the agent": an
    // operator cannot choose to rewrite something they have never been shown,
    // and this box used to be empty on every install that had not customised it.
    mount('/agents/default');

    const prompt = await screen.findByLabelText(/^System prompt for/);
    expect((prompt as HTMLTextAreaElement).value).toContain('To the file tools it is the');
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

    // Cleared, and the placeholder asks for the choice rather than dressing the
    // empty state up as "resolved automatically" — which it never was.
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveTextContent('Choose a model');
  });

  it('refuses to save an agent left with no model', async () => {
    // The clearing above is the way an operator most easily ends up here, and
    // it used to save silently: `agents.defaults.model = ''` makes the runtime
    // report `configured: false` and refuse every turn.
    const { user, calls } = mount('/agents/default', TWO_PROVIDERS);

    await choose(user, 'Provider', /Ollama/);
    await choose(user, 'Model', /^llama3$/);
    await choose(user, 'Provider', /OpenAI/);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('cannot run a turn');
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveAttribute('aria-invalid', 'true');
    expect(patchesOf(calls)).toHaveLength(0);
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
  it('shows the settings it runs on, not a blank box and a promise', async () => {
    // The fixture's `reviewer` stores neither a model nor a budget. It used to
    // render as "Inherit — llama3" and an empty number, which asked the reader
    // to go and look up what this agent would actually do; the boxes now hold
    // it, and the first save writes it down.
    mount('/agents/reviewer');

    expect(await screen.findByRole('combobox', { name: 'Model' })).toHaveTextContent('llama3');
    expect(screen.getByLabelText('Max output tokens')).toHaveValue('4096');
    expect(screen.queryByText(/Inherit/)).not.toBeInTheDocument();
  });

  it('refreshes the agent list after the save, so a rename reaches the composer', async () => {
    // The reported bug. `/api/agents` is what the composer's picker renders,
    // and it is derived from the settings tree rather than part of it — so a
    // save that renamed an agent left the picker on the old name. The editor
    // did invalidate the query, but on the line *after* `save`, which is
    // fire-and-forget: the refetch raced the PATCH, answered from the config
    // still on the server, and nothing invalidated it again afterwards.
    const { user, calls } = mount('/agents/reviewer', statefulSettings());

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Second Reader');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({
      label: 'Second Reader',
      // Wholesale replacement, so the rest of the agent has to ride along.
      tools: { read_file: 'allow', list_dir: 'allow', exec: 'deny' },
    });

    // The assertion that would have caught it: the agents query is refetched,
    // and only after the write it is meant to reflect.
    await waitFor(() => {
      const patchAt = calls.findIndex((call) => call.method === 'PATCH');
      const refetched = calls.findIndex(
        (call, index) => index > patchAt && call.method === 'GET' && call.path === '/api/agents',
      );
      expect(refetched).toBeGreaterThan(patchAt);
    });
  });

  it('writes the filled-in settings down on the first save', async () => {
    // The point of prepopulating: after this, a change to `agents.defaults`
    // does not silently move this agent. The edit is to an unrelated field —
    // saving *anything* is what commits the settings the form was filled with.
    const { user, calls } = mount('/agents/reviewer');

    await user.type(await screen.findByLabelText('Name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({
      model: 'llama3',
      provider: 'ollama',
      maxTokens: 4096,
    });
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

    await pick(user, 'write_file', 'Ask first');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });

    const [patch] = patchesOf(calls);
    expect(patch?.agents?.list?.reviewer).toMatchObject({
      // The whole map, every save — the fixture's three plus the one just added.
      tools: { read_file: 'allow', list_dir: 'allow', exec: 'deny', write_file: 'ask' },
    });
    // The defaults are not touched by editing one agent.
    expect(patch?.agents).not.toHaveProperty('defaults');
  });

  it('puts exec at the top, above the alphabetical rest', async () => {
    // The row this section is opened to look at. Alphabetical sorted it second
    // by accident of spelling, between `edit_file` and `list_dir`.
    mount('/agents/reviewer', {
      '/api/tools': [
        200,
        {
          tools: [
            { name: 'edit_file', description: '', risk: 'write', parameters: {} },
            { name: 'exec', description: '', risk: 'exec', parameters: {} },
            { name: 'read_file', description: '', risk: 'safe', parameters: {} },
          ],
        },
      ],
    });

    await screen.findByRole('combobox', { name: 'Permission for edit_file' });
    const rows = within(screen.getByRole('region', { name: 'Tools' })).getAllByRole('listitem');
    const startsWith = rows.map((row) => row.textContent);

    // The row's text opens with the tool's own name, so the order of the list
    // is readable off the prefixes. `exec` first, then A–Z — pinning one row
    // must not scramble the rest.
    expect(startsWith[0]?.startsWith('exec')).toBe(true);
    expect(startsWith[1]?.startsWith('edit_file')).toBe(true);
    expect(startsWith[2]?.startsWith('list_dir')).toBe(true);
    expect(startsWith[3]?.startsWith('read_file')).toBe(true);
  });

  it('keeps a tool this install does not have registered', async () => {
    // `agents.list.*` is replaced wholesale on save, so a list built only from
    // the live registry would silently drop this agent's opinion about a tool
    // whose MCP server happens to be down — and it would not come back.
    const { user, calls } = mount('/agents/reviewer', {
      '/api/tools': [
        200,
        { tools: [{ name: 'read_file', description: '', risk: 'safe', parameters: {} }] },
      ],
    });

    // `read_file` arrives with the tools query; `exec` is already on screen from
    // the stored map, so waiting for the slower one is what makes this assert
    // the union rather than a race.
    await pick(user, 'read_file', 'Ask first');
    expect(screen.getByRole('combobox', { name: 'Permission for exec' })).toBeInTheDocument();
    // `exec` and `list_dir` are both in the stored map and neither is
    // registered in this fixture, so both rows carry the badge.
    expect(screen.getAllByText('not installed')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer).toMatchObject({
      tools: { read_file: 'ask', list_dir: 'allow', exec: 'deny' },
    });
  });

  it('disables a tool by choosing Disabled, with no separate switch to disagree with it', async () => {
    const { user, calls } = mount('/agents/reviewer', {
      '/api/tools': [
        200,
        { tools: [{ name: 'read_file', description: '', risk: 'safe', parameters: {} }] },
      ],
    });

    await pick(user, 'read_file', 'Disabled');
    expect(screen.queryByRole('switch', { name: 'read_file' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    // `deny` rather than a dropped key: both read as off, but only this one
    // leaves a row in the editor to switch back on.
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer?.tools).toMatchObject({
      read_file: 'deny',
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

/**
 * The toolbox picker.
 *
 * Untested until a one-way door shipped: a `SelectItem` may not carry an empty
 * value — Radix reserves it for "nothing chosen" — so "None" existed only as the
 * placeholder, which shows while the field is empty and is unreachable once it is
 * not. An agent could be put in a container and never taken out of one without
 * hand-editing the config file.
 */
describe('choosing a toolbox', () => {
  const BOXED = ConfigSchema.parse({
    agents: {
      defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 },
      list: {
        researcher: {
          label: 'Researcher',
          toolbox: { name: 'web-research', network: { mode: 'open', allow: [] } },
        },
      },
    },
    providers: { ollama: { type: 'ollama' } },
  });

  const ROUTES: Record<string, StubRoute> = {
    '/api/settings': [200, { config: BOXED, credentialsPresent: { ollama: false } }],
    'PATCH /api/settings': [200, { config: BOXED, credentialsPresent: { ollama: false } }],
    '/api/agents': [
      200,
      {
        agents: [
          { id: 'default', label: 'default', model: 'llama3', provider: 'ollama' },
          { id: 'researcher', label: 'Researcher', model: 'llama3', provider: 'ollama' },
        ],
      },
    ],
    '/api/toolboxes': [
      200,
      {
        toolboxes: [
          {
            name: 'web-research',
            label: 'Web research',
            tools: [
              { name: 'search', use: 'Search the web.', permission: 'allow' },
              { name: 'fetch', use: 'Read a page.', permission: 'ask' },
            ],
            exposesTools: true,
            version: '3.0.0',
            image: `sha256:${'a'.repeat(64)}`,
            maxNetwork: 'open',
            capsAdded: [],
            weakened: [],
            approved: true,
          },
        ],
      },
    ],
  };

  async function choose(
    user: ReturnType<typeof userEvent.setup>,
    field: string,
    option: RegExp,
  ): Promise<void> {
    await user.click(await screen.findByRole('combobox', { name: field }));
    await user.click(await screen.findByRole('option', { name: option }));
  }

  it('offers “no toolbox” as something you can pick, not just as a placeholder', async () => {
    const { user } = mount('/agents/researcher', ROUTES);

    await user.click(await screen.findByRole('combobox', { name: 'Toolbox' }));

    expect(
      await screen.findByRole('option', { name: /None — run commands on this machine/ }),
    ).toBeInTheDocument();
  });

  it('takes an agent back out of its container', async () => {
    // The regression. Before the fix the only way out was editing config.json.
    const { user, calls } = mount('/agents/researcher', ROUTES);

    await choose(user, 'Toolbox', /None — run commands on this machine/);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.researcher?.toolbox?.name).toBe('');
  });

  it('hides the network field once there is no container to scope', async () => {
    const { user } = mount('/agents/researcher', ROUTES);

    expect(await screen.findByRole('combobox', { name: 'Network' })).toBeInTheDocument();
    await choose(user, 'Toolbox', /None — run commands on this machine/);

    expect(screen.queryByRole('combobox', { name: 'Network' })).not.toBeInTheDocument();
  });

  it('gives a toolbox program one row, not one in each list', async () => {
    // An override of a toolbox program lands in the same map as everything
    // else, but the program is not in the shared registry — so the built-in
    // list used to pick it up out of the map and badge it "not installed",
    // beside the group below that knew perfectly well what it was.
    mount('/agents/researcher', {
      ...ROUTES,
      // Registered, so the only thing that could badge "not installed" is a
      // toolbox program that leaked into the list above.
      '/api/tools': [
        200,
        { tools: [{ name: 'read_file', description: '', risk: 'safe', parameters: {} }] },
      ],
      '/api/settings': [
        200,
        {
          config: ConfigSchema.parse({
            agents: {
              defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 },
              list: {
                researcher: {
                  label: 'Researcher',
                  tools: { read_file: 'allow', search: 'deny' },
                  toolbox: { name: 'web-research', network: { mode: 'open', allow: [] } },
                },
              },
            },
            providers: { ollama: { type: 'ollama' } },
          }),
          credentialsPresent: { ollama: false },
        },
      ],
    });

    // Both queries have to have landed before the lists mean anything: the
    // group heading proves `/api/toolboxes` did, the risk badge proves
    // `/api/tools` did. Asserting an absence before either would pass on an
    // empty screen.
    await screen.findByText('From the Web research toolbox');
    await screen.findByText('safe');

    expect(screen.getAllByRole('combobox', { name: 'Permission for search' })).toHaveLength(1);
    expect(screen.queryByText('not installed')).not.toBeInTheDocument();
  });

  it('puts an agent into a container, and the sentinel never reaches the wire', async () => {
    const { user, calls } = mount('/agents/researcher', ROUTES);

    await choose(user, 'Toolbox', /None — run commands on this machine/);
    await choose(user, 'Toolbox', /Web research/);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    const name = patchesOf(calls)[0]?.agents?.list?.researcher?.toolbox?.name;
    expect(name).toBe('web-research');
    expect(name).not.toContain('none');
  });
});

describe('subagents', () => {
  it('offers every other agent, and never the one being edited', async () => {
    const { user } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Add subagent' }));
    await user.click(screen.getByRole('combobox', { name: 'Agent for subagent 1' }));

    expect(await screen.findByRole('option', { name: 'default' })).toBeInTheDocument();
    // Self-delegation is refused at save, so it is not offered.
    expect(screen.queryByRole('option', { name: 'Reviewer' })).not.toBeInTheDocument();
  });

  it('shows the tool name the model will call, which is derived not typed', async () => {
    const { user } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Add subagent' }));
    await user.click(screen.getByRole('combobox', { name: 'Agent for subagent 1' }));
    await user.click(await screen.findByRole('option', { name: 'default' }));

    expect(screen.getByText('ask_default')).toBeInTheDocument();
  });

  it('shows the sentence the model would read when the box is left empty', async () => {
    // It used to hold an *example* of what an operator might write, so the only
    // clue about the default was a hint saying one existed. This is the real
    // one, from the same function the loop hands to the provider.
    const { user } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Add subagent' }));
    await user.click(screen.getByRole('combobox', { name: 'Agent for subagent 1' }));
    await user.click(await screen.findByRole('option', { name: 'default' }));

    expect(screen.getByLabelText('When to use subagent 1')).toHaveAttribute(
      'placeholder',
      defaultSubagentPrompt('default'),
    );
  });

  it('gives the guidance box room to show that sentence', async () => {
    // A textarea rather than an input, and the reason is the placeholder rather
    // than the typing: the default runs to a couple of sentences, and one line
    // showed about forty characters of it.
    const { user } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Add subagent' }));

    expect(screen.getByLabelText('When to use subagent 1').tagName).toBe('TEXTAREA');
  });

  it('leaves the placeholder empty until an agent is chosen', async () => {
    // There is no agent to name yet, and a sentence about an unnamed one would
    // be a description of nothing.
    const { user } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Add subagent' }));

    expect(screen.getByLabelText('When to use subagent 1')).toHaveAttribute('placeholder', '');
  });

  it('saves the ref, its guidance and its permission', async () => {
    const { user, calls } = mount('/agents/reviewer');

    await user.click(await screen.findByRole('button', { name: 'Add subagent' }));
    await user.click(screen.getByRole('combobox', { name: 'Agent for subagent 1' }));
    await user.click(await screen.findByRole('option', { name: 'default' }));
    await user.type(
      screen.getByLabelText('When to use subagent 1'),
      'Use for anything outside review.',
    );
    await user.click(screen.getByRole('combobox', { name: 'Permission for subagent 1' }));
    await user.click(await screen.findByRole('option', { name: 'Ask first' }));

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer?.subagents).toEqual([
      { id: 'default', prompt: 'Use for anything outside review.', permission: 'ask' },
    ]);
  });

  it('removes a row, and the save says so', async () => {
    const { user, calls } = mount('/agents/reviewer', {
      '/api/settings': [
        200,
        {
          config: ConfigSchema.parse({
            agents: {
              defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 },
              list: {
                reviewer: {
                  label: 'Reviewer',
                  tools: { read_file: 'allow' },
                  subagents: [{ id: 'default', prompt: 'Ask.', permission: 'allow' }],
                },
              },
            },
            providers: { ollama: { type: 'ollama' } },
          }),
          credentialsPresent: { ollama: false },
        },
      ],
    });

    await user.click(await screen.findByRole('button', { name: 'Remove subagent 1' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    // The empty array rather than an absent key: `agents.list.*` replaces
    // wholesale, so this is the only shape that expresses a removal.
    expect(patchesOf(calls)[0]?.agents?.list?.reviewer?.subagents).toEqual([]);
  });

  it('says so when there is nobody to delegate to', async () => {
    const { user } = mount('/agents/reviewer', {
      '/api/agents': [
        200,
        { agents: [{ id: 'reviewer', label: 'Reviewer', model: 'm', provider: 'p' }] },
      ],
    });

    expect(
      await screen.findByText(/There is no other agent to delegate to yet/),
    ).toBeInTheDocument();
    expect(user).toBeDefined();
  });
});

describe('renaming an agent', () => {
  it('sends the rename with the patch, in one request', async () => {
    // Two requests meant two writes with a window between them: the rename
    // could land and the patch fail, leaving the agent under its new name
    // holding its old settings.
    const { user, calls } = mount('/agents/reviewer', statefulSettings());

    const id = await screen.findByLabelText('Identifier');
    await user.clear(id);
    await user.type(id, 'code-review');
    // The same Save every other box on this screen waits for.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).not.toHaveLength(0);
    });
    const patches = patchesOf(calls);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      renameAgents: [{ from: 'reviewer', to: 'code-review' }],
    });
    // The entry travels in the same body, addressed to the id it will have.
    expect(patches[0]?.agents?.list?.['code-review']).toBeDefined();
    // Nothing went anywhere else.
    expect(calls.filter((call) => call.method === 'POST')).toEqual([]);
  });

  it('says what the id will become, since the box takes a label’s worth of typing', async () => {
    const { user } = mount('/agents/reviewer', statefulSettings());

    const id = await screen.findByLabelText('Identifier');
    await user.clear(id);
    await user.type(id, 'Code Review');

    expect(await screen.findByText(/Will be renamed to “code-review”/)).toBeInTheDocument();
  });

  it('does not touch the rename endpoint when only other fields changed', async () => {
    // The id is a field like any other, so a save that left it alone must not
    // send a key move — a rename that is a no-op on the server is still a write
    // it has to reason about.
    const { user, calls } = mount('/agents/reviewer', statefulSettings());

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Second Opinion');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).not.toHaveLength(0);
    });
    expect(patchesOf(calls).some((patch) => 'renameAgents' in patch)).toBe(false);
  });

  it('keeps the other edits made alongside the rename', async () => {
    // The bug the separate button had: renaming navigated to the new id, which
    // remounts this editor, and every unsaved box went with it. One button
    // cannot lose a change it is the one committing.
    const { user, calls } = mount('/agents/reviewer', {
      ...statefulSettings(),
      'POST /api/agents/reviewer/rename': [
        200,
        {
          agent: {
            id: 'code-review',
            label: 'Second Opinion',
            model: 'llama3',
            provider: 'ollama',
          },
          previousId: 'reviewer',
          sessionsMoved: 0,
        },
      ],
    });

    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Second Opinion');
    const id = screen.getByLabelText('Identifier');
    await user.clear(id);
    await user.type(id, 'code-review');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The label edit survived, and it was written against the *new* id.
    await waitFor(() => {
      expect(
        patchesOf(calls).some(
          (patch) => patch.agents?.list?.['code-review']?.label === 'Second Opinion',
        ),
      ).toBe(true);
    });
  });

  it('refuses an id another agent already holds, before anything is sent', async () => {
    // Checked against the settings tree rather than `/api/agents`, which omits
    // the disabled agents — colliding with a switched-off one is still the
    // collision the server answers with a 409.
    const twoAgents = ConfigSchema.parse({
      ...CONFIG,
      agents: {
        ...CONFIG.agents,
        list: { ...CONFIG.agents.list, writer: { label: 'Writer', enabled: false } },
      },
    });
    const { user, calls } = mount('/agents/reviewer', statefulSettings(twoAgents));

    const id = await screen.findByLabelText('Identifier');
    await user.clear(id);
    await user.type(id, 'writer');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/already an agent called/)).toBeInTheDocument();
    // Refused before anything is sent, so the entry edits do not go either.
    expect(patchesOf(calls)).toHaveLength(0);
  });

  it('does not offer to rename the default agent', async () => {
    // It resolves whether or not it has an entry, and an install with no
    // default agent is not a state anything downstream can use.
    mount('/agents/default');

    await screen.findByLabelText('Name');
    expect(screen.queryByLabelText('Identifier')).not.toBeInTheDocument();
  });
});
