/**
 * TanStack Query, configured once.
 *
 * Two settings carry the reasoning:
 *
 *  - **A 401 is never retried.** It is not a transient failure; it is the
 *    answer. Retrying it three times delays the login overlay by a second and
 *    burns three requests against the login rate limit for nothing.
 *  - **`refetchOnWindowFocus` is off.** The live surfaces here are driven by the
 *    WebSocket, not by polling — Step 17's transport pushes turn state, and
 *    refetching every REST query each time the tab regains focus would fight it.
 *
 * Query keys live here rather than beside their components so that a mutation
 * in Step 18 can invalidate what a panel in Step 17 rendered without importing
 * it.
 */

import { QueryClient } from '@tanstack/react-query';

import { ApiError } from './api.js';

export const queryKeys = {
  me: ['auth', 'me'] as const,
  status: ['status'] as const,
  sessions: ['sessions'] as const,
  messages: (key: string) => ['sessions', key, 'messages'] as const,
  notifications: ['notifications'] as const,
  settings: ['settings'] as const,
  providers: ['providers'] as const,
  models: ['models'] as const,
  tools: ['tools'] as const,
  files: (path: string) => ['files', path] as const,
};

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && (error.isUnauthenticated || error.status < 500)) {
            return false;
          }
          return failureCount < 2;
        },
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
