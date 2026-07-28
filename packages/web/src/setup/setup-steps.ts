/**
 * The first-run wizard, as a state machine with no DOM in it.
 *
 * Four steps, and the split between the first two and the last two is the only
 * structural idea here. **Access is mandatory and configuration is not.** A
 * server that nobody has claimed is a shell-capable agent with no password, so
 * `code` and `password` have to complete. A server with no model is merely an
 * install that cannot chat yet — files, settings, workspaces and notifications
 * all work — so `provider` and `model` are skippable, and skipping them lands
 * the operator in a working app rather than in a dead end.
 *
 * Kept as a module of pure functions rather than as state inside the overlay so
 * that the ordering, the skip rules and the "what does Back mean here" question
 * can be tested without rendering anything. The overlay owns the answers; this
 * owns which question comes next.
 */

export const SETUP_STEPS = ['code', 'password', 'provider', 'model', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Steps that may be skipped, and the reason each one may be.
 *
 * `code` and `password` are absent deliberately: skipping them would leave the
 * agent unclaimed, which is the state the wizard exists to end.
 */
const SKIPPABLE: ReadonlySet<SetupStep> = new Set<SetupStep>(['provider', 'model']);

export function isSkippable(step: SetupStep): boolean {
  return SKIPPABLE.has(step);
}

/**
 * The step after this one.
 *
 * `done` is its own successor rather than an error: a double-submit past the
 * last step should be a no-op, not a crash in an overlay the user cannot leave.
 */
export function nextStep(step: SetupStep): SetupStep {
  const index = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[Math.min(index + 1, SETUP_STEPS.length - 1)] ?? 'done';
}

/**
 * The step before this one, or `null` where going back is meaningless.
 *
 * Neither credential step has a Back, and for different reasons. `code` is the
 * first step, so there is nowhere to go; `password` cannot go back to `code`
 * because the code was single-use and has already been spent — offering a
 * button that leads to a form nothing will accept is worse than offering none.
 *
 * `from` is where this run of the wizard *opened*, and it stops Back from
 * leading somewhere the user was never sent: a claimed install with no model
 * starts at `provider`, and a Back to `password` there would be offering to
 * rotate a password nobody came here to change.
 */
export function previousStep(step: SetupStep, from: SetupStep = 'code'): SetupStep | null {
  if (step === 'code' || step === 'password' || step === 'done') return null;
  if (step === from) return null;
  const index = SETUP_STEPS.indexOf(step);
  return SETUP_STEPS[index - 1] ?? null;
}

export interface SetupProgress {
  /** 1-based, for "Step 2 of 4". `done` is not a step anyone is on. */
  readonly current: number;
  readonly total: number;
}

/** `done` reports as complete rather than as a fifth step. */
export function progressOf(step: SetupStep): SetupProgress {
  const total = SETUP_STEPS.length - 1;
  const index = SETUP_STEPS.indexOf(step);
  return { current: Math.min(index + 1, total), total };
}

/**
 * Where a browser opening the app should start.
 *
 * Three states, and the last two are the ones worth naming.
 *
 * An install whose password is already set but whose wizard was never finished
 * — the tab was closed after the password step — is *claimed*, so it must not
 * ask for a code that no longer exists; it goes straight to the provider step.
 *
 * `configured: undefined` means the question has not been answered yet, which
 * on a signed-out browser it never will be: `/api/status` needs a session.
 * Treating unknown as "not configured" would pop the wizard open in front of
 * the login form for anyone whose session had merely expired.
 */
export function initialStep(input: {
  readonly setupRequired: boolean;
  readonly configured: boolean | undefined;
}): SetupStep | null {
  if (input.setupRequired) return 'code';
  // Not "assume the worst": an unanswerable question is not a fresh install.
  if (input.configured === undefined) return null;
  // Nothing to do: a claimed, configured install is just the app.
  if (input.configured) return null;
  return 'provider';
}

export interface SetupTitle {
  readonly title: string;
  readonly note: string;
}

/** What each step says about itself. Here so the copy is testable and in one place. */
export function titleOf(step: SetupStep): SetupTitle {
  switch (step) {
    case 'code':
      return {
        title: 'Enter the setup code',
        note: 'It was printed in the terminal that started this server. It works once.',
      };
    case 'password':
      return {
        title: 'Choose a password',
        note: 'This agent can read and write files and run commands. Pick something you would use for a login.',
      };
    case 'provider':
      return {
        title: 'Add a model provider',
        note: 'A local server like Ollama, or a cloud provider. You can add more later, including a second one of the same type.',
      };
    case 'model':
      return {
        title: 'Choose a model',
        note: 'Listed by the provider itself where it can be asked. Anything else can be typed in.',
      };
    case 'done':
      return { title: 'Ready', note: 'Everything else lives in Settings.' };
  }
}
