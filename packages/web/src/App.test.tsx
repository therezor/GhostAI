/**
 * A smoke test for the swatch page.
 *
 * It is not a component test — there are no components yet, and Step 16 owns
 * the ones there will be. It is here because the swatch grid is the artefact
 * Step 15 is done against: if it renders, every token in the sheet is reachable
 * from a component, and the gate sweep in `tokens/gates.test.ts` has real
 * source to sweep rather than a file nobody executes.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

describe('the swatch page', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

  const markup = renderToStaticMarkup(<App />);

  it('renders every surface, text tier and role', () => {
    for (const token of ['surface-0', 'surface-3', 'fg-1', 'fg-3', 'accent', 'danger', 'info']) {
      expect(markup).toContain(token);
    }
  });

  it('offers the three-state theme control', () => {
    for (const preference of ['dark', 'light', 'system']) {
      expect(markup).toContain(`>${preference}</button>`);
    }
  });

  it('paints itself from tokens rather than from literals', () => {
    expect(markup).toContain('var(--color-surface-0)');
    expect(markup).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
