/**
 * The context inspector.
 *
 * Two things are asserted that a screenshot could not: the bar is measured
 * against the window rather than against itself, and the same numbers are
 * available as text. The second is not a nicety — the bar is `aria-hidden`, so
 * if the table were wrong or absent the panel would be empty for a screen
 * reader and nobody looking at it would know.
 */

import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ContextInspector } from './context-inspector.js';
import { renderWithProviders, stubApi, type StubRoute } from '@/test/render.js';

const CONTEXT = {
  sessionKey: 'web:1',
  systemPrompt: 'You are GhostAI, a helpful agent.',
  messages: [
    {
      id: 'm1',
      sessionKey: 'web:1',
      createdAtMs: 1,
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    },
  ],
  estimatedTokens: 5000,
  contextWindowTokens: 10_000,
  breakdown: { systemPrompt: 1000, tools: 1000, messages: 3000 },
};

function mount(routes: Record<string, StubRoute> = {}): ReturnType<typeof userEvent.setup> {
  stubApi({ '/api/sessions/web%3A1/context': [200, CONTEXT], ...routes });
  renderWithProviders(<ContextInspector sessionKey="web:1" />);
  return userEvent.setup();
}

describe('the context inspector', () => {
  it('has nothing to inspect before a conversation exists', () => {
    stubApi({});
    renderWithProviders(<ContextInspector sessionKey={undefined} />);

    // Asking for the context of a session the server never minted is a 404.
    expect(screen.getByRole('button', { name: 'Inspect context' })).toBeDisabled();
  });

  it('measures the budget against the window and says it in words', async () => {
    const user = mount();
    await user.click(screen.getByRole('button', { name: 'Inspect context' }));

    expect(await screen.findByText('5,000')).toBeInTheDocument();
    expect(screen.getByText(/of 10,000 tokens · 50%/)).toBeInTheDocument();
    expect(screen.getByText('5,000 free')).toBeInTheDocument();
  });

  it('breaks the total down by section, in a table and not only in a bar', async () => {
    const user = mount();
    await user.click(screen.getByRole('button', { name: 'Inspect context' }));

    const table = await screen.findByRole('table', { name: 'Token usage by section' });
    const rows = [...table.querySelectorAll('tbody tr')].map((row) => row.textContent);

    expect(rows).toEqual([
      'System prompt1,00010.0%',
      'Tool definitions1,00010.0%',
      'Conversation3,00030.0%',
    ]);
  });

  it('shows the prompt that would actually be sent', async () => {
    const user = mount();
    await user.click(screen.getByRole('button', { name: 'Inspect context' }));

    expect(await screen.findByText(/You are GhostAI, a helpful agent\./)).toBeInTheDocument();
    expect(screen.getByText('1 messages in the window')).toBeInTheDocument();
  });

  it('says a budget is over the window rather than rendering it as full', async () => {
    const user = mount({
      '/api/sessions/web%3A1/context': [200, { ...CONTEXT, estimatedTokens: 12_000 }],
    });
    await user.click(screen.getByRole('button', { name: 'Inspect context' }));

    // The distinction the panel exists for: "exactly full" and "twice over" are
    // the same picture, and only one of them explains a dropped turn.
    expect(await screen.findByText('over the window')).toBeInTheDocument();
    expect(screen.queryByText(/free/)).not.toBeInTheDocument();
  });

  it('does not treat a conversation that has not started as a failure', async () => {
    // The socket mints a session key the moment a tab connects; the store holds
    // no row for it until the first message lands. A red error there answers a
    // question nobody asked.
    const user = mount({
      '/api/sessions/web%3A1/context': [
        404,
        { error: { code: 'not_found', message: 'No session "web:1"' } },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Inspect context' }));

    expect(await screen.findByText(/this conversation has not started/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a real failure instead of an empty panel', async () => {
    const user = mount({
      '/api/sessions/web%3A1/context': [
        500,
        { error: { code: 'internal', message: 'the prompt could not be built' } },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Inspect context' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('the prompt could not be built');
    });
  });
});
