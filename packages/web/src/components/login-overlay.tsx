/**
 * The login overlay.
 *
 * An overlay rather than a route, for one reason: a session can expire at any
 * moment, including mid-turn. A `/login` route would mean navigating away from
 * a conversation, losing the composer's contents and the socket, and then
 * trying to navigate back to where the user was. An overlay covers the app,
 * takes the password, and leaves everything behind it exactly as it was.
 *
 * It renders only when the server says authentication is on *and* the caller is
 * not authenticated — `/api/auth/me` answers both questions in one request, and
 * a 401 from it is the normal state of a fresh browser rather than an error.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useState, type JSX, type SyntheticEvent } from 'react';

import { ApiError, api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from './ui/button.js';
import { Field } from './ui/field.js';

export function LoginOverlay(): JSX.Element | null {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');

  const me = useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.me(signal),
  });

  const login = useMutation({
    mutationFn: (secret: string) => api.login(secret),
    onSuccess: async () => {
      setPassword('');
      // Everything fetched while unauthenticated is a 401 in the cache.
      await queryClient.invalidateQueries();
    },
  });

  const unauthenticated = me.error instanceof ApiError && me.error.isUnauthenticated;
  if (!unauthenticated) return null;

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    login.mutate(password);
  };

  return (
    // Not a Dialog: there is nothing behind it to return focus to, and its
    // "closed" state is a successful login rather than an Escape key.
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-0 p-4"
    >
      <form
        onSubmit={submit}
        className="flex w-[min(24rem,100%)] flex-col gap-4 rounded-xl border border-line bg-surface-2 p-6 shadow-lg"
      >
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-accent-fg">
            <Lock className="size-4" />
            <span className="text-2xs font-medium tracking-wide uppercase">GhostAI</span>
          </div>
          <h1 id="login-title" className="text-lg font-medium">
            Sign in
          </h1>
          <p className="text-sm text-fg-2">This agent can read and write files and run commands.</p>
        </div>

        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          // The one place an autofocus is right: the overlay covers everything,
          // and the field is the only thing to interact with.
          autoFocus
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          error={errorMessageOf(login.error)}
        />

        <Button type="submit" variant="primary" disabled={login.isPending || password === ''}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}

/**
 * A wrong password and a rate limit are different messages. Anything else is
 * reported verbatim rather than flattened to "login failed" — an operator
 * debugging a reverse proxy needs the actual status.
 */
function errorMessageOf(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (!(error instanceof ApiError)) return 'Could not reach the server.';
  if (error.status === 401) return 'Incorrect password.';
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.message;
}
