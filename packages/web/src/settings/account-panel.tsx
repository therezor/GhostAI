/**
 * The Account panel: the login name and the password behind it.
 *
 * The odd one out on this screen, and worth saying why. Every other panel edits
 * `config.json` through `PATCH /api/settings` and shares `SaveBar`'s
 * dirty-tracking. This one posts to `/api/setup/password`, because a credential
 * is not configuration: it lives in `auth_secrets`, it is one-way, and saving it
 * revokes every session in the install. Wiring it into the shared save bar would
 * put "rotate the password and sign out every other tab" behind the same button
 * that changes a temperature.
 *
 * Three properties this form has that a settings form does not:
 *
 *  - **The current password is required.** The session alone is not enough. It
 *    is `httpOnly`, but this application renders markdown a language model
 *    wrote, and the failure being closed here is an injection that changes the
 *    password and locks the operator out of their own agent.
 *  - **The name and the password move together.** There is deliberately no way
 *    to change the login name on its own, because that is changing half a
 *    credential without proving knowledge of the other half.
 *  - **It clears itself on success.** Three password fields left populated after
 *    a save are three password fields sitting in the DOM of a long-lived tab.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type JSX, type SyntheticEvent } from 'react';

import { DEFAULT_USERNAME, PASSWORD_MIN_LENGTH } from '@ghostai/protocol';

import { ApiError, api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import { toast } from '@/components/ui/toast.js';
import { Section, TextField } from './controls.js';

export function AccountPanel(): JSX.Element {
  const queryClient = useQueryClient();

  // The name in force, which is the only place in the UI it can be read from —
  // it is on the authenticated `/api/auth/me` and nowhere public.
  const me = useQuery({ queryKey: queryKeys.me, queryFn: ({ signal }) => api.me(signal) });
  const current = me.data?.username ?? DEFAULT_USERNAME;

  const [username, setUsername] = useState<string | null>(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  // `null` until the field is touched, so the value the server reports wins on
  // first render and a slow `/api/auth/me` cannot leave the box empty.
  const name = username ?? current;

  const change = useMutation({
    mutationFn: () =>
      api.setSetupPassword({
        password,
        currentPassword,
        ...(name.trim() === current ? {} : { username: name.trim() }),
      }),
    onSuccess: async () => {
      setUsername(null);
      setCurrentPassword('');
      setPassword('');
      setConfirm('');
      toast.success(
        'Password changed',
        'Every other signed-in session was revoked. This tab stayed signed in.',
      );
      // The name may have moved, and `me` is where it is read from.
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    change.mutate();
  };

  const tooShort = password !== '' && password.length < PASSWORD_MIN_LENGTH;

  return (
    <form onSubmit={submit} className="stack">
      <Section
        title="Sign-in"
        description="The username and password this server is reached with. Changing either signs out every other session, which is the point: the reason to rotate a credential is that the old one may be known."
      >
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          spellCheck={false}
          value={name}
          onValueChange={setUsername}
          hint={`Letters, digits, dots, dashes and underscores. The default is “${DEFAULT_USERNAME}”.`}
        />

        <TextField
          label="Current password"
          type="password"
          name="current-password"
          autoComplete="current-password"
          value={currentPassword}
          onValueChange={setCurrentPassword}
          error={change.error === null ? undefined : errorMessageOf(change.error)}
          hint="Required. A session on its own is not enough to change the credential it was minted from."
        />

        <TextField
          label="New password"
          type="password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onValueChange={setPassword}
          error={tooShort ? `At least ${String(PASSWORD_MIN_LENGTH)} characters.` : undefined}
          hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters. Behind it is an agent that can read files and run commands on this machine.`}
        />

        <TextField
          label="Confirm new password"
          type="password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onValueChange={setConfirm}
          error={mismatch ? 'The two passwords do not match.' : undefined}
        />

        <div className="cluster settings-save-bar">
          <Button
            type="submit"
            variant="primary"
            disabled={
              change.isPending ||
              currentPassword === '' ||
              password.length < PASSWORD_MIN_LENGTH ||
              name.trim() === ''
            }
          >
            {change.isPending ? 'Saving…' : 'Change password'}
          </Button>
        </div>
      </Section>
    </form>
  );
}

/**
 * The server's own text wherever it has one.
 *
 * A 401 here means one thing — the current password was wrong — and saying so
 * is not an enumeration risk: the caller already holds a session, so they are
 * not learning anything a stranger could use. A 429 is shown verbatim because
 * the server's message names the number of seconds to wait.
 */
function errorMessageOf(error: unknown): string {
  if (!(error instanceof ApiError)) return 'Could not reach the server.';
  if (error.status === 401) return 'That is not the current password.';
  return error.message;
}
