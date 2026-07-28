/**
 * The style guide page.
 *
 * It is a smoke test with a purpose beyond "does it render": this page is the
 * one surface that instantiates every token and every recipe variant, so if it
 * mounts and its markup contains no literal colour, then every token in the
 * sheet is reachable from a component without one. The gate sweep in
 * `tokens/gates.test.ts` checks the source; this checks the output.
 */

import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TokensRoute } from './tokens.js';
import { renderWithProviders } from '@/test/render.js';

describe('the style guide', () => {
  it('renders every surface, text tier and role', () => {
    renderWithProviders(<TokensRoute />);

    for (const token of ['surface-0', 'surface-3', 'fg-1', 'fg-3', 'accent', 'danger', 'info']) {
      expect(screen.getAllByText(new RegExp(token)).length).toBeGreaterThan(0);
    }
  });

  it('exercises every button and badge variant, which is what makes it a review surface', () => {
    renderWithProviders(<TokensRoute />);

    for (const variant of ['primary', 'secondary', 'ghost', 'danger', 'link']) {
      expect(screen.getByRole('button', { name: `${variant} md` })).toBeInTheDocument();
    }
    // soft, solid and outline × six roles.
    expect(screen.getAllByText('warning')).toHaveLength(4);
  });

  it('paints itself from tokens rather than from literals', () => {
    const { container } = renderWithProviders(<TokensRoute />);

    expect(container.innerHTML).toContain('var(--surface-0)');
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
