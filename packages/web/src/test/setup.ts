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
import { resetConnection } from '@/lib/connection.js';
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

/**
 * A socket that never connects.
 *
 * jsdom implements `WebSocket` for real, so the shell mounting the transport
 * would have every component test open a TCP connection to a server that is not
 * running — and then reconnect to it on a backoff schedule for the rest of the
 * file. A suite that wants to drive the transport constructs
 * `ReconnectingSocket` with its own `create`; nothing else should be dialling
 * anything.
 */
class InertWebSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  send(): void {
    // Nowhere to send it.
  }
  close(): void {
    // Never opened.
  }
}

/**
 * Storage in a `Map`, replaced per test.
 *
 * Two reasons, and only the second is about isolation. The first is that Node
 * 26 ships its own experimental `sessionStorage` global which shadows jsdom's
 * and is inert without `--localstorage-file`, so a `setItem` succeeds and a
 * `getItem` returns null — which reads as a bug in the code under test. The
 * second is that the reconnect cursor is deliberately durable, and durable
 * across a page reload should not mean durable across a test file.
 */
class MemoryStorage implements Storage {
  readonly #entries = new Map<string, string>();

  get length(): number {
    return this.#entries.size;
  }
  clear(): void {
    this.#entries.clear();
  }
  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.#entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#entries.set(key, value);
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
    // The transcript pins itself to the bottom through this one.
    scrollTo: () => undefined,
  });

  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  vi.stubGlobal('WebSocket', InertWebSocket);
  vi.stubGlobal('sessionStorage', new MemoryStorage());
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
  // All three are module state: without this, one test's toast is another
  // test's unexpected element, a connection status leaks across files, and a
  // socket opened by a shell that was never unmounted keeps its listeners.
  resetToasts();
  resetConnection();
  useTurnStore.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
