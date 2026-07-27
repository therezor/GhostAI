/**
 * Structural properties of the token sheet — the things the contrast assertion
 * cannot see because they are about how the sheet is *written* rather than what
 * it resolves to.
 *
 * The first is the important one. `tokens.css` declares the light seeds twice,
 * once under `prefers-color-scheme` and once under `[data-theme='light']`,
 * because a media query and an attribute selector cannot share a selector list.
 * Everything else in this file is downstream of that duplication being safe.
 */

import { describe, expect, it } from 'vitest';

import { parseDeclarations, readTokensCss, resolveTokens } from '../tokens/sheet.js';

const css = readTokensCss();
const declarations = parseDeclarations(css);

describe('the two light seed blocks', () => {
  const inMediaQuery = declarations.filter((declaration) => declaration.media !== undefined);
  const inAttribute = declarations.filter((declaration) =>
    declaration.selector.includes("[data-theme='light']"),
  );

  it('both exist', () => {
    expect(inMediaQuery.length).toBeGreaterThan(0);
    expect(inAttribute.length).toBe(inMediaQuery.length);
  });

  it('declare exactly the same properties with the same values', () => {
    const pairs = (source: typeof declarations): readonly string[] =>
      source.map(({ property, value }) => `${property}: ${value}`);

    expect(pairs(inAttribute)).toEqual(pairs(inMediaQuery));
  });

  it('override every seed the dark block declares', () => {
    // A seed missing from the light blocks silently keeps its dark value —
    // which is how a light theme ends up with one component still inverted.
    const dark = new Set(
      declarations
        .filter((declaration) => declaration.media === undefined)
        .filter((declaration) => declaration.selector.trim() === ':root')
        .filter((declaration) => declaration.property.startsWith('--seed-'))
        .map((declaration) => declaration.property),
    );
    const light = new Set(inAttribute.map((declaration) => declaration.property));

    // Shared on purpose. The gold is the gold — only its lightness and chroma
    // move between themes — and `--seed-on-fill-l` is text on a fill, which is
    // light in both themes, so it is near-black in both.
    const shared = [
      '--seed-accent-l',
      '--seed-accent-c',
      '--seed-accent-h',
      '--seed-neutral-h',
      '--seed-on-fill-l',
    ];
    const missing = [...dark].filter((seed) => !light.has(seed) && !shared.includes(seed));

    expect(missing).toEqual([]);
  });
});

describe('the Tailwind theme', () => {
  const themed = declarations
    .filter((declaration) => declaration.selector.startsWith('@theme'))
    .map((declaration) => declaration.property);

  it('is declared `inline`, so a theme flip repaints without rebuilding CSS', () => {
    const colorBlock = declarations.find((declaration) =>
      declaration.property.startsWith('--color-'),
    );

    expect(colorBlock?.selector).toBe('@theme inline');
  });

  it('exposes every colour the components use', () => {
    for (const token of [
      '--color-surface-0',
      '--color-surface-3',
      '--color-fg-1',
      '--color-fg-3',
      '--color-hover',
      '--color-line',
      '--color-accent',
      '--color-accent-fg',
      '--color-on-fill',
      '--color-danger-soft',
    ]) {
      expect(themed).toContain(token);
    }
  });

  it('resolves every token to a literal in both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const [property, value] of resolveTokens(css, theme)) {
        expect(value, `${property} in ${theme}`).not.toContain('var(');
      }
    }
  });
});

describe('sizing', () => {
  const sizes = declarations.filter(
    (declaration) =>
      declaration.property.startsWith('--text-') ||
      declaration.property.startsWith('--radius-') ||
      declaration.property.startsWith('--spacing'),
  );

  it('is expressed in rem, so the UI honours the browser font size', () => {
    for (const { property, value } of sizes) {
      expect(value, property).toMatch(/rem$/);
    }
  });

  it('never overrides the root font size', () => {
    // The one way to make a rem scale stop honouring the browser setting.
    expect(css).not.toMatch(/html\s*\{[^}]*font-size/);
  });
});
