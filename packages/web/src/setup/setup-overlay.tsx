/**
 * The first-run wizard.
 *
 * An overlay rather than a route, for the reason the login overlay is one:
 * there is nothing behind it to navigate back from, and its "closed" state is a
 * finished setup rather than an Escape key. It sits *above* the login overlay,
 * because on an unclaimed install `/api/auth/me` also 401s and both would
 * otherwise render at once — and the one that can actually get the user in is
 * this one.
 *
 * Four steps, split by whether they may be skipped. Access — the code, then the
 * password — is mandatory, because an unclaimed server is a shell-capable agent
 * with no password. Configuration — a provider, then a model — is not, because
 * an install with no model still serves files, settings, workspaces and
 * notifications; only chat is unavailable. Skipping lands in a working app with
 * a pointer in the composer rather than in a dead end.
 *
 * The step machine lives in `setup-steps.ts` with no DOM in it. This file owns
 * the answers; that one owns which question comes next.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX, type SyntheticEvent } from 'react';

import { DEFAULT_USERNAME, PASSWORD_MIN_LENGTH, type ProviderInfo } from '@ghostai/protocol';

import { ApiError, api } from '@/lib/api.js';
import { queryKeys } from '@/lib/query.js';
import { Button } from '@/components/ui/button.js';
import { Field } from '@/components/ui/field.js';
import { Wordmark } from '@/components/wordmark.js';
import { SelectField, TextField } from '@/settings/controls.js';
import { EMPTY_PROVIDER_FORM, toCreateProviderPatch } from '@/settings/provider-form.js';
import {
  initialStep,
  isSkippable,
  nextStep,
  previousStep,
  progressOf,
  titleOf,
  type SetupStep,
} from './setup-steps.js';

export function SetupOverlay(): JSX.Element | null {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<SetupStep | null>(null);
  // Where this run opened, so Back cannot lead behind it.
  const [from, setFrom] = useState<SetupStep>('code');
  const [instanceId, setInstanceId] = useState('');

  // Public, so it answers on a browser with no session — which is the only
  // state an unclaimed install has.
  const setup = useQuery({
    queryKey: queryKeys.setup,
    queryFn: ({ signal }) => api.setupStatus(signal),
  });

  // 401 while unclaimed, which is why the wizard cannot depend on it to decide
  // whether to open. It is read only to answer "is there a model yet".
  const status = useQuery({
    queryKey: queryKeys.status,
    queryFn: ({ signal }) => api.status(signal),
    retry: false,
  });

  const required = setup.data?.required;
  const configured = status.data?.configured;

  useEffect(() => {
    // Only ever *opens* the wizard. Once a step is showing, this must not move
    // it: every step changes one of these two flags, and re-deriving would walk
    // the user backwards the moment they finished a step.
    if (step !== null || required === undefined) return;
    const first = initialStep({ setupRequired: required, configured });
    if (first !== null) setFrom(first);
    setStep(first);
  }, [step, required, configured]);

  if (step === null || step === 'done') return null;

  const finish = async (): Promise<void> => {
    setStep('done');
    // Everything fetched while unclaimed is a 401 in the cache.
    await queryClient.invalidateQueries();
  };

  const advance = (): void => {
    const next = nextStep(step);
    if (next === 'done') void finish();
    else setStep(next);
  };

  const { title, note } = titleOf(step);
  const progress = progressOf(step);
  const back = previousStep(step, from);

  return (
    // Not a Dialog: there is nothing behind it to return focus to, and its
    // "closed" state is a finished setup rather than an Escape key.
    <div role="dialog" aria-modal="true" aria-labelledby="setup-title" className="setup-overlay">
      <div className="stack setup-card">
        <div className="stack setup-card__header">
          <Wordmark className="eyebrow" />
          <p className="setup-card__progress">
            Step {progress.current} of {progress.total}
          </p>
          <h1 id="setup-title" className="setup-card__title">
            {title}
          </h1>
          <p className="setup-card__note">{note}</p>
        </div>

        {step === 'code' && <CodeStep onDone={advance} />}
        {step === 'password' && <PasswordStep onDone={advance} />}
        {step === 'provider' && (
          <ProviderStep
            onDone={(id) => {
              setInstanceId(id);
              advance();
            }}
          />
        )}
        {step === 'model' && <ModelStep instanceId={instanceId} onDone={advance} />}

        <div className="row setup-card__actions">
          {back !== null && (
            <Button
              variant="ghost"
              onClick={() => {
                setStep(back);
              }}
            >
              Back
            </Button>
          )}
          <span className="spacer" />
          {isSkippable(step) && (
            <Button variant="ghost" onClick={advance}>
              Skip
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function CodeStep({ onDone }: { readonly onDone: () => void }): JSX.Element {
  const [code, setCode] = useState('');
  const claim = useMutation({
    mutationFn: (value: string) => api.claimSetup(value),
    onSuccess: onDone,
  });

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    claim.mutate(code);
  };

  return (
    <form onSubmit={submit} className="stack setup-card__body">
      <Field
        label="Setup code"
        name="code"
        // The one place an autofocus is right: the overlay covers everything,
        // and this field is the only thing to interact with.
        autoFocus
        autoComplete="one-time-code"
        spellCheck={false}
        className="setup-card__code"
        placeholder="XXXX-XXXX-XXXX"
        value={code}
        onChange={(event) => {
          setCode(event.target.value);
        }}
        error={messageOf(claim.error, 'Incorrect or already-used setup code.')}
        hint="Dashes and capitals are optional."
      />
      <Button type="submit" variant="primary" disabled={claim.isPending || code.trim() === ''}>
        {claim.isPending ? 'Checking…' : 'Continue'}
      </Button>
    </form>
  );
}

function PasswordStep({ onDone }: { readonly onDone: () => void }): JSX.Element {
  // Prefilled and editable rather than asked for. Naming the account is not a
  // decision a first run should have to stop for, and an empty field here would
  // make it one — but the field is present so that an operator who wants a name
  // other than the default never has to find out where it is changed later.
  const [username, setUsername] = useState(DEFAULT_USERNAME);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const set = useMutation({
    mutationFn: (value: { username: string; password: string }) => api.setSetupPassword(value),
    onSuccess: onDone,
  });

  // Checked on submit rather than on every keystroke: a mismatch while the
  // second field is half-typed is not a mistake yet.
  const [mismatch, setMismatch] = useState(false);

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    set.mutate({ username: username.trim(), password });
  };

  return (
    <form onSubmit={submit} className="stack setup-card__body">
      <Field
        label="Username"
        name="username"
        autoComplete="username"
        spellCheck={false}
        autoFocus
        value={username}
        onChange={(event) => {
          setUsername(event.target.value);
        }}
        hint="Signing in takes this and the password below."
      />
      <Field
        label="Password"
        type="password"
        name="new-password"
        autoComplete="new-password"
        value={password}
        onChange={(event) => {
          setPassword(event.target.value);
        }}
        hint={`At least ${String(PASSWORD_MIN_LENGTH)} characters. Behind it is an agent that can read files and run commands on this machine.`}
      />
      <Field
        label="Confirm password"
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        value={confirm}
        onChange={(event) => {
          setConfirm(event.target.value);
        }}
        error={
          mismatch
            ? 'The two passwords do not match.'
            : messageOf(set.error, 'Could not set the password.')
        }
      />
      <Button
        type="submit"
        variant="primary"
        // The length is checked here as well as on the server, so the wizard
        // answers instantly instead of round-tripping to be told the rule.
        disabled={set.isPending || password.length < PASSWORD_MIN_LENGTH || username.trim() === ''}
      >
        {set.isPending ? 'Saving…' : 'Continue'}
      </Button>
    </form>
  );
}

function ProviderStep({ onDone }: { readonly onDone: (instanceId: string) => void }): JSX.Element {
  const [type, setType] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [key, setKey] = useState('');

  const providers = useQuery({
    queryKey: queryKeys.providers,
    queryFn: ({ signal }) => api.providers(signal),
  });

  const add = useMutation({
    mutationFn: async (chosen: ProviderInfo) => {
      // The bare type as the instance id: this is the first provider on a fresh
      // install, so nothing is taken. Adding a second of the same type from the
      // settings panel is where the `-2` suffix comes in.
      const id = chosen.id;
      // Through the same builder the settings dialog uses, on the same form
      // shape: the wizard asks for a subset of the fields, not for a different
      // patch. An empty `apiBase` is read as "unset" and falls back to the
      // registry's default.
      await api.patchSettings(
        toCreateProviderPatch(id, { ...EMPTY_PROVIDER_FORM, type: chosen.id, apiBase }),
      );
      // After the instance exists, because the vault is keyed by instance id.
      const trimmedKey = key.trim();
      if (trimmedKey !== '') {
        await api.setCredential({ namespace: 'providers', key: id, value: trimmedKey });
      }
      return id;
    },
    onSuccess: onDone,
  });

  const chosen = providers.data?.types.find((candidate) => candidate.id === type);

  return (
    <div className="stack setup-card__body">
      <SelectField
        label="Provider"
        value={type}
        placeholder="Choose one"
        options={(providers.data?.types ?? []).map((candidate) => ({
          value: candidate.id,
          label: candidate.displayName,
        }))}
        onValueChange={setType}
        hint={
          chosen === undefined
            ? 'Anything OpenAI-compatible works. Pick Custom if yours is not listed.'
            : chosen.isLocal
              ? 'A server on this machine or your network. Usually needs no key.'
              : 'A cloud provider. Needs an API key.'
        }
      />

      {chosen !== undefined && (
        <>
          <TextField
            label="API base"
            value={apiBase}
            placeholder={chosen.defaultApiBase ?? 'Required for this provider'}
            spellCheck={false}
            onValueChange={setApiBase}
            hint="Empty uses the default shown above."
          />
          <TextField
            label={chosen.isLocal ? 'API token (optional)' : 'API key'}
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={key}
            onValueChange={setKey}
            hint={
              chosen.isLocal
                ? 'Only if your server sits behind an authenticating proxy.'
                : 'Written to the encrypted vault. It is never sent back to the browser.'
            }
          />
        </>
      )}

      <Button
        variant="primary"
        disabled={chosen === undefined || add.isPending}
        onClick={() => {
          if (chosen !== undefined) add.mutate(chosen);
        }}
      >
        {add.isPending ? 'Adding…' : 'Continue'}
      </Button>
      {add.error !== null && (
        <p role="alert" className="field__message field__message--error">
          {messageOf(add.error, 'Could not add the provider.')}
        </p>
      )}
    </div>
  );
}

function ModelStep({
  instanceId,
  onDone,
}: {
  readonly instanceId: string;
  readonly onDone: () => void;
}): JSX.Element {
  const [model, setModel] = useState('');

  // The refresh route rather than the cached GET: the provider was added
  // seconds ago, so anything cached predates it.
  const models = useQuery({
    queryKey: [...queryKeys.models, instanceId],
    queryFn: () => api.refreshModels(),
  });

  const save = useMutation({
    mutationFn: (chosen: string) =>
      api.patchSettings({
        agents: { defaults: { provider: instanceId, model: chosen } },
      }),
    onSuccess: onDone,
  });

  const offered = (models.data?.models ?? [])
    .filter((entry) => instanceId === '' || entry.providerId === instanceId)
    .map((entry) => entry.id)
    .sort((a, b) => a.localeCompare(b));

  const failure = models.data?.errors[instanceId];

  return (
    <div className="stack setup-card__body">
      {models.isPending ? (
        <p className="setup-card__note">Asking the provider what it has…</p>
      ) : offered.length > 0 ? (
        <SelectField
          label="Model"
          value={model}
          placeholder="Choose one"
          options={offered.map((id) => ({ value: id, label: id }))}
          onValueChange={setModel}
        />
      ) : (
        <TextField
          label="Model"
          value={model}
          spellCheck={false}
          placeholder="qwen3:8b"
          onValueChange={setModel}
          hint={
            failure === undefined
              ? 'This provider does not list its models. Type the id you want to use.'
              : `Could not reach the provider: ${failure}. Type a model id, or skip and try again from Settings.`
          }
        />
      )}

      <Button
        variant="primary"
        disabled={model.trim() === '' || save.isPending}
        onClick={() => {
          save.mutate(model.trim());
        }}
      >
        {save.isPending ? 'Saving…' : 'Finish'}
      </Button>
    </div>
  );
}

/**
 * A server message where there is one, and a written fallback where there is
 * not.
 *
 * The server's own text is preferable — "auth cannot be disabled on a LAN bind"
 * is the whole answer and "could not save" is none of it — but a network
 * failure has no message worth showing, so each caller supplies the sentence
 * that fits its step.
 */
function messageOf(error: unknown, fallback: string): string | undefined {
  if (error === null || error === undefined) return undefined;
  if (!(error instanceof ApiError)) return 'Could not reach the server.';
  if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  return error.status === 401 ? fallback : error.message;
}
