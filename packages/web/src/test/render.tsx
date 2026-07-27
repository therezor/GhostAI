/**
 * Rendering helpers.
 *
 * `renderWithProviders` mounts the same provider stack `main.tsx` does, minus
 * the router, so a component test exercises the real Query client and the real
 * tooltip provider rather than a simplified stand-in that behaves differently.
 *
 * The Query client is built per call with retries off: a test asserting an
 * error state should not wait for three exponential backoffs first.
 */

import { QueryClient } from '@tanstack/react-query';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';

import { Providers } from '@/app/providers.js';

export function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithProviders(
  ui: ReactElement,
  client: QueryClient = testQueryClient(),
): RenderResult & { readonly client: QueryClient } {
  const result = render(<Providers client={client}>{ui}</Providers>);
  return Object.assign(result, { client });
}

/**
 * A `fetch` that answers from a table of `path → [status, body]`.
 *
 * A hand-written mock per test ends up asserting the mock; this asserts the
 * component, and an unlisted path is a loud failure rather than a hang.
 */
export function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

export function stubFetch(routes: Record<string, [number, unknown]>): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = urlOf(input);
    const path = url.split('?')[0] ?? url;
    const match = routes[path];

    if (match === undefined) {
      return Promise.reject(new Error(`Unstubbed request: ${url}`));
    }

    const [status, body] = match;
    return Promise.resolve(
      new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
}
