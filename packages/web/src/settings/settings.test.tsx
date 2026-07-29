/**
 * Settings, driven through the real router.
 *
 * The two cases that decide whether the step landed are here, and neither is a
 * rendering question:
 *
 *  - **A key saved in the UI reaches the vault and nothing else.** It goes out
 *    once, as a `PUT` to the credentials route, and appears in no other request,
 *    in no response, and nowhere in the DOM afterwards. The runtime re-reads the
 *    vault on every provider build, so that write is the whole of "usable on the
 *    next turn with no restart" from this side of the wire.
 *  - **A panel saves its own section and nothing else.** `ConfigPatch` is a
 *    deep-partial precisely so that saving one panel does not rewrite another's
 *    fields, and the assertion is on what went over the wire rather than on
 *    what the screen says afterwards.
 *
 * The agent cases used to live here. They moved to `agents/agents.test.tsx`
 * with the panel: the model and budget it edited are the default agent's, and
 * they are edited on that agent now.
 */

import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { ConfigSchema, type ConfigPatch } from '@ghostai/protocol';

import { Providers } from '@/app/providers.js';
import { createAppRouter } from '@/app/router.js';
import { stubApi, testQueryClient, type RecordedRequest, type StubRoute } from '@/test/render.js';

const CONFIG = ConfigSchema.parse({
  agents: { defaults: { model: 'llama3', provider: 'ollama', maxTokens: 4096 } },
  providers: {
    ollama: { type: 'ollama', apiBase: 'http://127.0.0.1:11434/v1', models: ['llama3'] },
    openai: { type: 'openai' },
  },
});

const SETTINGS = { config: CONFIG, credentialsPresent: { ollama: false, openai: true } };

/**
 * Both halves of the response: the registry catalogue an endpoint is added
 * from, and the endpoints that have been. They are different lists now — the
 * panel used to render one row per registry entry, and renders one per
 * configured endpoint instead.
 */
const PROVIDERS = {
  types: [
    {
      id: 'ollama',
      displayName: 'Ollama',
      wire: 'openai',
      isLocal: true,
      isGateway: false,
      isOAuth: false,
      defaultApiBase: 'http://127.0.0.1:11434/v1',
      supportsModelListing: true,
    },
    {
      id: 'openai',
      displayName: 'OpenAI',
      wire: 'openai',
      isLocal: false,
      isGateway: false,
      isOAuth: false,
      envKey: 'OPENAI_API_KEY',
      supportsModelListing: true,
    },
  ],
  instances: [
    {
      id: 'ollama',
      type: 'ollama',
      displayName: 'Ollama',
      apiBase: 'http://127.0.0.1:11434/v1',
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
      apiBase: 'https://api.openai.com/v1',
      isLocal: false,
      isGateway: false,
      isOAuth: false,
      envKey: 'OPENAI_API_KEY',
      enabled: true,
      supportsModelListing: true,
      credentialsPresent: true,
    },
  ],
};

const TOOLS = {
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      parameters: {},
      risk: 'safe',
      source: 'builtin',
    },
    { name: 'exec', description: 'Run a command', parameters: {}, risk: 'exec', source: 'builtin' },
  ],
};

const SHELL_ROUTES: Record<string, StubRoute> = {
  '/api/auth/me': [200, { authenticated: true, authEnabled: false }],
  // Claimed: the setup overlay mounts above the login one and would
  // otherwise be deciding whether to open on an unstubbed request.
  '/api/setup': [200, { required: false }],
  '/api/status': [
    200,
    {
      version: '0.0.0',
      protocolVersion: 1,
      uptimeMs: 1,
      model: 'llama3',
      provider: 'ollama',
      workspace: '/tmp/w',
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
  path = '/settings',
  overrides: Record<string, StubRoute> = {},
): {
  readonly user: ReturnType<typeof userEvent.setup>;
  readonly calls: RecordedRequest[];
  readonly router: ReturnType<typeof createAppRouter>;
} {
  const calls = stubApi({
    ...SHELL_ROUTES,
    '/api/settings': [200, SETTINGS],
    'PATCH /api/settings': [200, SETTINGS],
    'PUT /api/settings/credentials': [204, null],
    '/api/providers': [200, PROVIDERS],
    '/api/models': [200, { models: [{ id: 'llama3', providerId: 'ollama' }], errors: {} }],
    '/api/tools': [200, TOOLS],
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

  return { user, calls, router };
}

const patchesOf = (calls: readonly RecordedRequest[]): ConfigPatch[] =>
  calls.filter((call) => call.method === 'PATCH').map((call) => call.body as ConfigPatch);

beforeEach(() => {
  // Nothing to reset here beyond what `test/setup.ts` already does; the stub is
  // installed per mount so each case owns its own routes.
});

describe('the settings screen', () => {
  it('warns when the settings file failed to parse and defaults are in use', async () => {
    mount('/settings', {
      '/api/settings': [200, { ...SETTINGS, loadError: 'Unexpected token }' }],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
  });
});

/** The kebab on one row, then the item on it. */
async function rowAction(
  user: ReturnType<typeof userEvent.setup>,
  row: string,
  action: string,
): Promise<void> {
  await user.click(await screen.findByRole('button', { name: `Actions for ${row}` }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

/**
 * The list only.
 *
 * Everything about *one* endpoint — its base URL, its key, its catalogue — is
 * edited on a route of its own now, and is covered in `provider-editor.test.tsx`
 * with the rest of that screen. What belongs here is what the list itself does:
 * what it reports at a glance, and the three acts that need no form.
 */
describe('the providers panel', () => {
  it('reports each endpoint\u2019s key and status in words rather than in colour', async () => {
    mount('/settings?panel=providers');

    const rows = within(await screen.findByRole('table')).getAllByRole('row');
    // Header, then one per endpoint.
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('no key');
    expect(rows[1]).toHaveTextContent('Enabled');
    expect(rows[2]).toHaveTextContent('key saved');
  });

  it('shows a disabled endpoint as disabled rather than hiding it', async () => {
    mount('/settings?panel=providers', {
      '/api/providers': [
        200,
        {
          types: PROVIDERS.types,
          instances: [{ ...PROVIDERS.instances[0], enabled: false }, PROVIDERS.instances[1]],
        },
      ],
    });

    const rows = within(await screen.findByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Disabled');
  });

  it('switches one off from the list, without asking', async () => {
    // Reversible where Delete is not, so it is one press and no dialog \u2014 the
    // same rule the agents list follows.
    const { user, calls } = mount('/settings?panel=providers');

    await rowAction(user, 'Ollama', 'Disable');

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.providers).toEqual({ ollama: { enabled: false } });
  });

  it('offers Enable on one that is already off', async () => {
    const { user, calls } = mount('/settings?panel=providers', {
      '/api/providers': [
        200,
        {
          types: PROVIDERS.types,
          instances: [{ ...PROVIDERS.instances[0], enabled: false }],
        },
      ],
    });

    await rowAction(user, 'Ollama', 'Enable');

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.providers).toEqual({ ollama: { enabled: true } });
  });

  it('creates an endpoint and opens its editor, the way New agent does', async () => {
    // The type is the one question the editor cannot ask \u2014 it is fixed for the
    // life of an instance \u2014 so it is the only one the dialog asks.
    const { user, calls, router } = mount('/settings?panel=providers');

    await user.click(await screen.findByRole('button', { name: 'New provider' }));
    await user.click(await screen.findByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: 'Ollama' }));

    const dialog = within(screen.getByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'GPU box');
    await user.click(dialog.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    // A free id: a second Ollama is a second endpoint, not a merge into the
    // first.
    expect(patchesOf(calls)[0]?.providers).toEqual({
      'ollama-2': { type: 'ollama', label: 'GPU box', apiBase: '', models: [], enabled: true },
    });

    // On success, not on the press: navigating early lands the editor on a
    // settings cache that has never seen the endpoint it was sent to.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/settings/providers/ollama-2');
    });
  });

  it('asks before deleting, because the key goes with it', async () => {
    const { user, calls } = mount('/settings?panel=providers');

    await rowAction(user, 'OpenAI', 'Delete');
    expect(await screen.findByRole('dialog')).toHaveTextContent('its saved key is deleted with it');
    // Asking is not doing.
    expect(patchesOf(calls)).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.providers).toEqual({ openai: null });
  });

  it('has no way to ask every endpoint at once', async () => {
    // It used to. One closed laptop made the whole action look broken, and
    // fetching a catalogue is a thing you do *to an endpoint* \u2014 so it lives in
    // that endpoint's editor.
    mount('/settings?panel=providers');

    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /Refresh model lists/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check for models/ })).not.toBeInTheDocument();
  });
});

describe('the tools panel', () => {
  it('shows the matrix and what it does to each registered tool', async () => {
    mount('/settings?panel=tools');

    expect(await screen.findByRole('combobox', { name: 'Execute policy' })).toHaveTextContent(
      'Ask first',
    );

    const list = screen.getByRole('region', { name: 'Registered tools' });
    const rows = await within(list).findAllByRole('listitem');
    const textOf = (prefix: string): string =>
      rows.find((row) => row.textContent.startsWith(prefix))?.textContent ?? '';

    // `exec: ask` in the matrix, so the exec tool reads "Ask first" — which is
    // the connection the matrix on its own cannot make.
    expect(textOf('exec')).toContain('Ask first');
    expect(textOf('read_file')).toContain('Run it');
  });

  it('saves a changed policy as a tools patch', async () => {
    const { user, calls } = mount('/settings?panel=tools');

    await user.click(await screen.findByRole('combobox', { name: 'Execute policy' }));
    await user.click(await screen.findByRole('option', { name: 'Refuse' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });

    const [patch] = patchesOf(calls);
    expect(patch?.tools?.approvals?.exec).toBe('deny');
    expect(Object.keys(patch ?? {})).toEqual(['tools']);
  });

  it('refuses an approval timeout of zero', async () => {
    const { user, calls } = mount('/settings?panel=tools');

    const timeout = await screen.findByLabelText('Approval timeout (seconds)');
    await user.clear(timeout);
    await user.type(timeout, '0');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Must be at least 1');
    expect(patchesOf(calls)).toHaveLength(0);
  });
});

describe('a panel whose system lands in a later phase', () => {
  it('says which phase rather than rendering a form that does nothing', async () => {
    mount('/settings?panel=extensions');

    expect(await screen.findByText('MCP servers')).toBeInTheDocument();
    expect(screen.getByText('Plugins').closest('li')?.textContent).toContain('Phase 4');
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('is reachable from the tab strip and lands in the URL', async () => {
    const { user, router } = mount();

    await user.click(await screen.findByRole('tab', { name: 'Automation' }));
    expect(await screen.findByText('Scheduled jobs')).toBeInTheDocument();
    // The panel is in the URL, which is what makes "set your key here" a link
    // rather than a sentence describing four clicks.
    expect(router.state.location.searchStr).toContain('panel=automation');
  });
});

/**
 * The Account panel.
 *
 * Not a settings form, and the cases below are the three ways that shows: it
 * posts to the credential route rather than to `PATCH /api/settings`, it will
 * not submit without the current password, and it sends the username only when
 * the username actually changed.
 */
describe('the account panel', () => {
  const ACCOUNT_ROUTES: Record<string, StubRoute> = {
    '/api/auth/me': [200, { authenticated: true, authEnabled: true, username: 'ghost' }],
    'POST /api/setup/password': [200, { ok: true, expiresAtMs: 99 }],
  };

  it('changes the password without touching the settings tree', async () => {
    const { user, calls } = mount('/settings?panel=account', ACCOUNT_ROUTES);

    await user.type(await screen.findByLabelText('Current password'), 'the old password');
    await user.type(screen.getByLabelText('New password'), 'the new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'the new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => {
      expect(calls.find((call) => call.path === '/api/setup/password')?.body).toEqual({
        currentPassword: 'the old password',
        password: 'the new password',
      });
    });
    // The username is absent because it did not change — sending it back
    // unchanged would be a rotation of a credential nobody asked to rotate.
    expect(patchesOf(calls)).toEqual([]);
  });

  it('sends the username when it is the thing that changed', async () => {
    const { user, calls } = mount('/settings?panel=account', ACCOUNT_ROUTES);

    const username = await screen.findByLabelText('Username');
    await waitFor(() => {
      expect(username).toHaveValue('ghost');
    });
    await user.clear(username);
    await user.type(username, 'operator');
    await user.type(screen.getByLabelText('Current password'), 'the old password');
    await user.type(screen.getByLabelText('New password'), 'the new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'the new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    await waitFor(() => {
      expect(calls.find((call) => call.path === '/api/setup/password')?.body).toEqual({
        username: 'operator',
        currentPassword: 'the old password',
        password: 'the new password',
      });
    });
  });

  // A session is not enough to change the credential it was minted from, and
  // the form says so before spending a request finding out.
  it('will not submit without the current password', async () => {
    const { user } = mount('/settings?panel=account', ACCOUNT_ROUTES);

    await user.type(await screen.findByLabelText('New password'), 'the new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'the new password');

    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
  });

  it('refuses two new passwords that differ, without asking the server', async () => {
    const { user, calls } = mount('/settings?panel=account', ACCOUNT_ROUTES);

    await user.type(await screen.findByLabelText('Current password'), 'the old password');
    await user.type(screen.getByLabelText('New password'), 'the new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a different one');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
    expect(calls.some((call) => call.path === '/api/setup/password')).toBe(false);
  });

  it('says the current password was wrong rather than reporting a generic failure', async () => {
    const { user } = mount('/settings?panel=account', {
      ...ACCOUNT_ROUTES,
      'POST /api/setup/password': [
        401,
        { error: { code: 'unauthorized', message: 'Incorrect current password' } },
      ],
    });

    await user.type(await screen.findByLabelText('Current password'), 'not the old one');
    await user.type(screen.getByLabelText('New password'), 'the new password');
    await user.type(screen.getByLabelText('Confirm new password'), 'the new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('not the current password');
  });
});
