/**
 * The mark, and the copy of it in `public/favicon.svg`.
 *
 * The favicon cannot import the component — a browser tab has no cascade, so it
 * needs its colour written out — which makes it the one duplicated drawing in
 * the package. Duplication that nothing checks is duplication that drifts, and
 * this drift is invisible: nobody looks at a favicon twice. So the path is
 * exported from the component and asserted to appear in the file, the same way
 * `theme.test.ts` holds the pre-paint script to the theme module.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skull, SKULL_PATH } from './skull.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const favicon = readFileSync(join(PACKAGE_ROOT, 'public', 'favicon.svg'), 'utf8');

describe('the skull', () => {
  it('takes its colour from the text tier it is placed in', () => {
    // The whole reason it is a component rather than an `<img>`: it follows the
    // theme, and `size-*` sizes it, with nothing to do at the call site.
    const { container } = render(<Skull className="size-10 text-fg-3" />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('fill', 'currentColor');
    expect(svg).toHaveClass('size-10', 'text-fg-3');
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
  });

  it('knocks its sockets out rather than painting them', () => {
    // A knockout painted in the background colour stops being a hole the moment
    // the mark is placed on any other surface.
    const { container } = render(<Skull />);
    const svg = container.querySelector('svg');

    expect(svg).toHaveAttribute('fill-rule', 'evenodd');
    expect(svg?.querySelectorAll('path')).toHaveLength(1);
  });

  it('cuts the teeth into the outline, so nothing is too small to survive', () => {
    // The bottom edge steps up and down; there is no separate detail to lose at
    // favicon size. Three tabs, 1.5 units deep on a solid jaw — cut to the full
    // depth of the jaw they read as legs rather than as teeth.
    expect(SKULL_PATH).toContain('v4.5h-2V20h-2v1.5h-2V20H9v1.5H7');
  });
});

describe('the favicon', () => {
  it('is the same drawing, path for path', () => {
    expect(favicon).toContain(SKULL_PATH);
  });

  it('writes its colour out, because a tab has no cascade to inherit from', () => {
    expect(favicon).not.toContain('currentColor');
    // The brand gold, resolved from `oklch(0.763 0.155 77.3)`.
    expect(favicon).toContain('#e8a317');
  });

  it('is referenced by index.html, from this origin', () => {
    const index = readFileSync(join(PACKAGE_ROOT, 'index.html'), 'utf8');

    expect(index).toContain('rel="icon" href="/favicon.svg"');
  });
});
