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
 *    deep-partial precisely so that saving the Agent panel does not rewrite the
 *    tool approvals, and the assertion is on what went over the wire rather than
 *    on what the screen says afterwards.
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
  providers: { ollama: { apiBase: 'http://127.0.0.1:11434/v1', models: ['llama3'] } },
});

const SETTINGS = { config: CONFIG, credentialsPresent: { ollama: false, openai: true } };

const PROVIDERS = {
  providers: [
    {
      id: 'ollama',
      displayName: 'Ollama',
      wire: 'openai',
      isLocal: true,
      isGateway: false,
      isOAuth: false,
      defaultApiBase: 'http://127.0.0.1:11434/v1',
      credentialsPresent: false,
    },
    {
      id: 'openai',
      displayName: 'OpenAI',
      wire: 'openai',
      isLocal: false,
      isGateway: false,
      isOAuth: false,
      envKey: 'OPENAI_API_KEY',
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

describe('the agent panel', () => {
  it('shows what the config says, not what the schema defaults to', async () => {
    mount();

    const maxTokens = await screen.findByLabelText('Max output tokens');
    expect(maxTokens).toHaveValue('4096');
    expect(screen.getByLabelText('Workspace directory')).toHaveValue('');
  });

  it('labels an unset reasoning effort rather than rendering a blank control', async () => {
    // An empty `value` means *no* value to a Radix select, so the option would
    // select nothing and the trigger would render blank — a control that looks
    // broken while working perfectly.
    mount();

    expect(await screen.findByRole('combobox', { name: 'Reasoning effort' })).toHaveTextContent(
      "The provider's default",
    );
  });

  it('says what an unset model means, in the control itself', async () => {
    const withoutModel = ConfigSchema.parse({ agents: { defaults: { provider: 'ollama' } } });
    mount('/settings', { '/api/settings': [200, { ...SETTINGS, config: withoutModel }] });

    expect(await screen.findByRole('combobox', { name: 'Model' })).toHaveTextContent(
      'Resolved automatically',
    );
  });

  it('saves only the agent subtree', async () => {
    const { user, calls } = mount();

    const maxTokens = await screen.findByLabelText('Max output tokens');
    await user.clear(maxTokens);
    await user.type(maxTokens, '2048');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });

    const [patch] = patchesOf(calls);
    expect(patch?.agents?.defaults?.maxTokens).toBe(2048);
    // The whole point of a deep-partial: the tool approvals this panel never
    // showed must not be rewritten to their defaults by saving it.
    expect(Object.keys(patch ?? {})).toEqual(['agents']);
  });

  it('refuses to send a patch it knows is invalid, and says which field', async () => {
    const { user, calls } = mount();

    const temperature = await screen.findByLabelText('Temperature');
    await user.clear(temperature);
    await user.type(temperature, '9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Must be at most 2');
    expect(temperature).toHaveAttribute('aria-invalid', 'true');
    expect(patchesOf(calls)).toHaveLength(0);
  });

  it('reverts to what the server holds', async () => {
    const { user } = mount();

    const maxTokens = await screen.findByLabelText('Max output tokens');
    await user.clear(maxTokens);
    await user.type(maxTokens, '10');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Revert' }));
    expect(maxTokens).toHaveValue('4096');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('warns when the settings file failed to parse and defaults are in use', async () => {
    mount('/settings', {
      '/api/settings': [200, { ...SETTINGS, loadError: 'Unexpected token }' }],
    });

    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
  });
});

describe('the providers panel', () => {
  it('states whether each provider has a key, in words rather than in colour', async () => {
    const { user } = mount('/settings?panel=providers');

    expect(await screen.findByRole('button', { name: /Ollama/ })).toHaveTextContent('no key');
    expect(screen.getByRole('button', { name: /OpenAI/ })).toHaveTextContent('key saved');

    await user.click(screen.getByRole('button', { name: /Ollama/ }));
    expect(await screen.findByLabelText('API base')).toHaveValue('http://127.0.0.1:11434/v1');
  });

  it('sends a key to the vault and keeps it out of everything else', async () => {
    const secret = 'sk-test-abc123';
    const { user, calls } = mount('/settings?panel=providers');

    await user.click(await screen.findByRole('button', { name: /OpenAI/ }));

    const field = await screen.findByLabelText('API key');
    // Never populated — there is nothing to populate it from — and masked.
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('type', 'password');

    await user.type(field, secret);
    await user.click(screen.getByRole('button', { name: 'Save key' }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });

    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe('/api/settings/credentials');
    expect(puts[0]?.body).toEqual({ namespace: 'providers', key: 'openai', value: secret });

    // The one request that may carry it is the one that did. Nothing else — not
    // the settings patch, not a refetch — has the key anywhere in it.
    const elsewhere = calls
      .filter((call) => call.method !== 'PUT')
      .map((call) => JSON.stringify(call.body ?? ''));
    expect(elsewhere.some((body) => body.includes(secret))).toBe(false);

    // And it is gone from the page: not in the field, not in the DOM.
    expect(field).toHaveValue('');
    expect(document.body.textContent).not.toContain(secret);
  });

  it('removes a key with its own press, so an empty field cannot delete one', async () => {
    const { user, calls } = mount('/settings?panel=providers');

    await user.click(await screen.findByRole('button', { name: /OpenAI/ }));
    // The save button is disabled while the field is empty, so the only way to
    // clear a key is the button that says so.
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    });
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      namespace: 'providers',
      key: 'openai',
      value: null,
    });
  });

  it('offers no key field for a local provider whose credential is never read', async () => {
    const { user } = mount('/settings?panel=providers');

    await user.click(await screen.findByRole('button', { name: /Ollama/ }));

    // `findCredential` does not open the vault for a local provider with no
    // environment key, so a field here would accept a key nothing would read.
    expect(await screen.findByText('This provider takes no key.')).toBeInTheDocument();
    expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('API base')).toBeInTheDocument();
  });

  it('offers no way to remove a key that is not there', async () => {
    const { user } = mount('/settings?panel=providers', {
      '/api/providers': [
        200,
        {
          providers: PROVIDERS.providers.map((provider) => ({
            ...provider,
            credentialsPresent: false,
          })),
        },
      ],
    });

    await user.click(await screen.findByRole('button', { name: /OpenAI/ }));
    await screen.findByLabelText('API key');
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('saves one provider’s connection without touching another’s', async () => {
    const { user, calls } = mount('/settings?panel=providers');

    await user.click(await screen.findByRole('button', { name: /Ollama/ }));
    const apiBase = await screen.findByLabelText('API base');
    await user.clear(apiBase);
    await user.type(apiBase, 'http://elsewhere/v1');
    await user.click(screen.getByRole('button', { name: 'Save connection' }));

    await waitFor(() => {
      expect(patchesOf(calls)).toHaveLength(1);
    });
    expect(patchesOf(calls)[0]?.providers).toEqual({
      ollama: { apiBase: 'http://elsewhere/v1', models: ['llama3'] },
    });
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
