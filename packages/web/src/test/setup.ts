/**
 * Shared setup for the component tests.
 *
 * Everything here exists because jsdom is not a browser in one specific way
 * each primitive depends on. Radix asks the layout engine questions jsdom has
 * no answer for — element sizes for collision-aware placement, pointer capture
 * for the select, `ResizeObserver` for anchored positioning — and without these
 * stubs the components throw rather than fail an assertion, which makes every
 * test read as a bug in the component.
 */

import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { resetToasts } from '@/components/ui/toast.js';
import { useTurnStore } from '@/state/turn.js';

/** A no-op observer. Nothing is being laid out, so there is nothing to report. */
class NoopResizeObserver {
  observe(): void {
    // Nothing to observe: jsdom has no layout.
  }
  unobserve(): void {
    // See above.
  }
  disconnect(): void {
    // See above.
  }
}

beforeEach(() => {
  // The DOM lib types all of these as always present, which is exactly why
  // their absence is a surprise: a menu that refuses to open rather than a
  // type error. `Object.assign` because they live on the prototype, where
  // `vi.stubGlobal` cannot reach.
  Object.assign(Element.prototype, {
    hasPointerCapture: () => false,
    setPointerCapture: () => undefined,
    releasePointerCapture: () => undefined,
    // Called when a menu opens on its highlighted item.
    scrollIntoView: () => undefined,
  });

  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  // The router scrolls to the top on every navigation; jsdom logs a
  // "Not implemented" line for each one.
  vi.stubGlobal('scrollTo', () => undefined);

  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  // Both are module state: without this, one test's toast is another test's
  // unexpected element, and a connection status leaks across files.
  resetToasts();
  useTurnStore.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
