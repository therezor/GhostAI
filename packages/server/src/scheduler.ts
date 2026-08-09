/**
 * The timer that runs jobs, and the lifecycle of one run.
 *
 * Here rather than in a package of its own because it needs the shared
 * `DatabaseSync`, the notification store and the hub — all of which are at this
 * level — and a package sitting beside `server` would have to import it back
 * for `TurnRunner` and the broadcast. It follows `SessionHub`'s discipline
 * instead: every collaborator arrives as a **structural port**, so
 * `scheduler.test.ts` drives the whole engine with a hand-moved clock, a
 * scripted connection and an in-memory store, and never stands up Fastify.
 *
 * Four decisions carry the file.
 *
 * **Turns go through the hub, not straight to a `TurnRunner`.** It would be
 * less code to call `run()` and read `TurnResult.text`, and it would be wrong.
 * `payload.sessionKey` exists precisely so a job can accumulate context in one
 * session across runs, and nothing stops two jobs — or a browser tab — naming
 * the same one. Two runs writing into a single history is the failure
 * `hub.ts`'s own header names: "a transcript no model can read and no user can
 * explain." A per-job in-flight set does not prevent it, because the collision
 * is *between* jobs. The hub is the only thing in the process that serialises a
 * session, and the caller most likely to collide is the last one that should be
 * routed around it. The cost is reconstructing the answer from
 * `assistant.delta` and `turn.end`, which is the twenty lines below.
 *
 * **The timer is one rearming `setTimeout` to the earliest due job**, not a
 * tick. A thirty-minute heartbeat should not cost a wakeup a second, and a tick
 * coarse enough to be cheap makes a one-shot late. Every hop is clamped to
 * `MAX_ARM_MS` — `setTimeout` overflows above 2^31-1 ms and fires
 * *immediately*, so an unclamped `at` job three months out would run the moment
 * it was created, in a loop.
 *
 * **A job never queues a second occurrence of itself.** The next run is
 * computed at *completion*, not at the scheduled instant, so a ten-minute run
 * on a five-minute interval produces a run every ten minutes rather than a
 * backlog that never drains. A provisional next time is written at dispatch so
 * that a hard kill leaves the job scheduled rather than unscheduled forever.
 *
 * **Every run writes a row before it does anything.** The row is the only
 * durable trace of a turn nobody watched, and a run that dies mid-flight has to
 * leave evidence rather than a gap — `reconcilePending` closes those out at the
 * next boot.
 */

import {
  DEFAULT_WORKSPACE_ID,
  GhostError,
  nextCronRun,
  parseCron,
  silentLogger,
  systemClock,
  toGhostError,
  type Clock,
  type Logger,
  type TimerHandle,
} from '@ghostwire/core';
import {
  AUTOMATION_ORIGIN,
  newUuid,
  type AutomationJob,
  type AutomationPayload,
  type AutomationRun,
  type AutomationSchedule,
  type ChatMessage,
  type Config,
  type Notification,
  type RunStatus,
  type ServerMessage,
  type ToolDefinition,
} from '@ghostwire/protocol';
import type { ChatResult } from '@ghostwire/providers';

import type { AutomationStore } from './automation-store.js';
import {
  HEARTBEAT_RESULT_TOOL,
  HEARTBEAT_TOOL,
  MAX_TASK_FILE_BYTES,
  buildDecideMessages,
  buildEvaluateMessages,
  readDecision,
  readEvaluation,
} from './heartbeat.js';
import type { CreateNotificationInput } from './notifications.js';

/**
 * The longest a single timer hop may be.
 *
 * Not a tuning knob. Node's `setTimeout` overflows past 2^31-1 ms (~24.8 days)
 * and fires immediately, which would turn a job scheduled for February into a
 * tight loop today. Twenty-four hours also bounds how far the wall clock can
 * drift — or be stepped by NTP, or by a laptop resuming — before the engine
 * re-reads what is actually due.
 */
export const MAX_ARM_MS: number = 24 * 60 * 60 * 1000;

/** How long a single run may take before it is abandoned. */
const DEFAULT_RUN_TIMEOUT_MS: number = 30 * 60 * 1000;

/**
 * The floor on a rearm that could otherwise be zero.
 *
 * Work stays *due* while the concurrency limit is saturated, so the delay to
 * "the earliest due job" is zero for as long as the slots are full. Without a
 * floor the timer would re-arm at 0 ms and fire again immediately, spinning the
 * event loop for the entire length of a slow run — a hot loop that does nothing
 * but re-read the same rows. A freed slot re-arms directly from the run's
 * `finally`, so this is the backstop rather than the mechanism.
 */
const BUSY_RETRY_MS: number = 1000;

/** What a dead process left behind, read at the next boot. */
const INTERRUPTED_BY_RESTART: string = 'Interrupted by a restart.';
const INTERRUPTED_BY_SHUTDOWN = 'Interrupted by shutdown.';

const NO_CHANNEL_WARNING =
  'This job asks for delivery, but no channel is wired yet — the result was recorded in the notification centre instead.';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What the scheduler needs of a hub connection. `HubClient` satisfies it. */
interface SchedulerConnection {
  receive(frame: unknown): void;
  close(): void;
}

export interface SchedulerConnectOptions {
  readonly send: (message: ServerMessage) => void;
  readonly sessionKey?: string;
  readonly channel?: string;
  readonly agentId?: string;
  /**
   * The workspace a session this run *creates* lands in.
   *
   * Narrows `ConnectOptions.workspaceId` on the hub and carries its rule: a run
   * pinned to a session that already exists leaves that session's workspace
   * alone.
   */
  readonly workspaceId?: string;
  /** Always true here: nobody is on the other end of a scheduled run. */
  readonly unattended?: boolean;
}

/** The notification frame, minus the `seq` the hub stamps per session. */
export interface NotificationBroadcast {
  readonly type: 'notification';
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly level: 'info' | 'success' | 'warning' | 'error';
  readonly createdAtMs: number;
  readonly sessionKey?: string;
  readonly jobId?: string;
}

/** One direct provider request. Absent means this build has no heartbeat. */
type SchedulerChat = (input: {
  readonly agentId?: string;
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  readonly toolChoice: 'auto' | 'none' | 'required';
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}) => Promise<ChatResult>;

/**
 * Reads one workspace-relative file, or throws. Absent means no heartbeat.
 *
 * An options object rather than positional arguments on purpose: `path` and
 * `workspaceId` are both strings, so adding the workspace as a third parameter
 * would make a transposition at a call site something the compiler cannot see.
 */
type SchedulerReadFile = (input: {
  readonly workspaceId: string;
  readonly path: string;
  readonly maxBytes: number;
}) => Promise<string>;

export interface SchedulerOptions {
  readonly jobs: AutomationStore;
  /** Live, never a snapshot: a settings save must move the next drain. */
  readonly config: () => Config;
  readonly connect: (options: SchedulerConnectOptions) => SchedulerConnection;
  readonly broadcast: (event: NotificationBroadcast) => void;
  readonly raise: (input: CreateNotificationInput) => Notification;
  /** Deletes a session a trimmed run had been the only reference to. */
  readonly deleteSession?: (sessionKey: string) => void;
  readonly chat?: SchedulerChat;
  readonly readFile?: SchedulerReadFile;
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly newId?: () => string;
  readonly runTimeoutMs?: number;
}

/** The narrow view the REST routes hold. */
export interface SchedulerPort {
  runNow(jobId: string): AutomationRun;
  refresh(): void;
  readonly enabled: boolean;
}

// ---------------------------------------------------------------------------
// Schedule arithmetic
// ---------------------------------------------------------------------------

/**
 * When a schedule next fires after an instant, or 0 for never again.
 *
 * 0 rather than null because that is what the column means — `next_run_at_ms
 * = 0` is "unscheduled", which covers a fired one-shot, a disabled job and a
 * cron expression like `0 0 30 2 *` that is legal to write and impossible to
 * reach. All three are the same to the timer.
 */
export function nextRunAfter(
  schedule: AutomationSchedule,
  fromMs: number,
  tz = 'UTC',
): number {
  switch (schedule.kind) {
    case 'at':
      return schedule.atMs > fromMs ? schedule.atMs : 0;
    case 'every':
      return fromMs + schedule.everyMs;
    case 'cron': {
      // The install's `ui.timezone`, and only it — a job has no zone of its own
      // any more. The same setting renders the next-run line, so the expression
      // is read against the clock the answer is printed against. Defaulting to
      // the *host* zone instead would make one expression fire at a different
      // instant after the server moved.
      const spec = parseCron(schedule.expr, tz);
      return nextCronRun(spec, fromMs) ?? 0;
    }
  }
}

/**
 * The first fire time for a job as created or edited.
 *
 * An `at` job whose instant is already past keeps it rather than being pushed
 * forward: the boot sweep is what decides whether a missed one-shot runs, and
 * silently moving it here would take that decision away from `catchUpOnBoot`.
 */
export function firstRunAt(
  schedule: AutomationSchedule,
  nowMs: number,
  enabled: boolean,
  tz = 'UTC',
): number {
  if (!enabled) return 0;
  if (schedule.kind === 'at') return schedule.atMs;
  return nextRunAfter(schedule, nowMs, tz);
}

// ---------------------------------------------------------------------------
// Collecting a turn's answer from the event stream
// ---------------------------------------------------------------------------

interface TurnOutcome {
  readonly text: string;
  readonly error: string | undefined;
  readonly warnings: readonly string[];
}

/**
 * Accumulates one turn's frames into an answer.
 *
 * The hub is a broadcast surface, not a request/response one, so this watches
 * for the `turn.end` matching the `turn.start` it saw and resolves there. The
 * shape mirrors `TurnProjection` in `@ghostwire/channels`, which does the same
 * job for a chat app — deliberately re-derived rather than imported, because
 * that package is a *sibling* of this one and the arrow would be a layering
 * change for twenty lines.
 */
class TurnCollector {
  private turnId: string | undefined;
  private text = '';
  private error: string | undefined;
  private readonly warnings: string[] = [];
  private settle: ((outcome: TurnOutcome) => void) | undefined;
  private done = false;

  readonly promise: Promise<TurnOutcome>;

  constructor() {
    this.promise = new Promise<TurnOutcome>((resolve) => {
      this.settle = resolve;
    });
  }

  receive(message: ServerMessage): void {
    if (this.done) return;
    switch (message.type) {
      case 'turn.start':
        this.turnId ??= message.turnId;
        return;
      case 'assistant.delta':
        this.text += message.text;
        return;
      case 'notice':
        this.warnings.push(message.message);
        return;
      case 'error':
        // A hub-level refusal — no model configured, the session is busy. It
        // arrives unsequenced and no `turn.end` follows it, so this is the only
        // place the run learns it will never start.
        this.error = message.message;
        this.finish();
        return;
      case 'turn.end':
        if (this.turnId !== undefined && message.turnId !== this.turnId) {
          return;
        }
        // `max_iterations` is a warning rather than a failure: the turn did work
        // and produced an answer, it just ran out of tool budget saying so.
        // Recording it as an error would notify the operator that a job broke
        // when what actually happened is that it was busy.
        if (message.stopReason === 'max_iterations') {
          this.warnings.push(
            'The turn hit its tool-iteration cap; the answer may be incomplete.',
          );
        } else if (message.stopReason !== 'complete') {
          this.error = `The turn ended early (${message.stopReason}).`;
        }
        this.finish();
        return;

      // Everything a job's transcript has no use for: the streams a person
      // watches, the connection bookkeeping a browser reconciles against, and
      // the tool traffic — a run records what the turn *said*, and the calls it
      // made along the way are in the session either way.
      //
      // Listed rather than swept up by a `default`, which is the whole point of
      // this change. `TurnProjection` next door is exhaustive and a protocol
      // event added without a decision there is a type error; here a `default`
      // meant a new event silently did nothing in every scheduled run, and
      // nothing anywhere said so.
      case 'connected':
      case 'pong':
      case 'message.ack':
      case 'message.queued':
      case 'reasoning.delta':
      case 'tool.call':
      case 'tool.progress':
      case 'tool.result':
      case 'tool.approvalRequest':
      case 'subagent.event':
      case 'session.status':
      case 'session.reset':
      case 'session.replay':
      case 'session.truncated':
      case 'notification':
      case 'tools.changed':
      case 'steer':
        return;
    }
    // Unreachable while the switch above is exhaustive, and a compile error the
    // moment it is not: `message` is `never` here only if every member of the
    // union has a case. This is the line that makes adding an event a decision.
    message satisfies never;
  }

  /** Settles with whatever has arrived. Idempotent. */
  finish(error?: string): void {
    if (this.done) return;
    this.done = true;
    if (error !== undefined) this.error = error;
    this.settle?.({
      text: this.text.trim(),
      error: this.error,
      warnings: [...this.warnings],
    });
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class Scheduler implements SchedulerPort {
  private readonly jobs: AutomationStore;
  private readonly config: () => Config;
  private readonly connect: (
    options: SchedulerConnectOptions,
  ) => SchedulerConnection;
  private readonly broadcast: (event: NotificationBroadcast) => void;
  private readonly raise: (input: CreateNotificationInput) => Notification;
  private readonly deleteSession: ((sessionKey: string) => void) | undefined;
  private readonly chat: SchedulerChat | undefined;
  private readonly readFile: SchedulerReadFile | undefined;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly newId: () => string;
  private readonly runTimeoutMs: number;

  private timer: TimerHandle | undefined;
  private started = false;
  private stopping = false;
  /**
   * The zone the stored `next_run_at_ms` values were computed against.
   *
   * `undefined` until `start()`, which is what makes the first `refresh()` after
   * a boot a no-op rather than a full rescan of jobs whose next run the boot
   * sweep just settled.
   */
  private zonedAt: string | undefined;
  /** Job ids with a run in flight. What stops a job overlapping itself. */
  private readonly inFlight = new Map<string, AbortController>();
  /** Every in-flight run's promise, so `stop()` can await the tail. */
  private readonly settling = new Set<Promise<void>>();

  constructor(options: SchedulerOptions) {
    this.jobs = options.jobs;
    this.config = options.config;
    this.connect = options.connect;
    this.broadcast = options.broadcast;
    this.raise = options.raise;
    this.deleteSession = options.deleteSession;
    this.chat = options.chat;
    this.readFile = options.readFile;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.newId = options.newId ?? newUuid;
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  }

  get enabled(): boolean {
    return this.config().scheduler.enabled;
  }

  /**
   * Read live, so changing it in Appearance moves the next rearm.
   *
   * `ui.timezone` rather than a scheduler setting of its own: this is the same
   * zone every timestamp is rendered in, which is what makes `0 9 * * *` mean
   * nine on the clock the operator is reading. `settings.patch` calls
   * `scheduler.refresh()`, so an existing cron job is rescheduled on the save
   * rather than on the next fire.
   */
  private timezone(): string {
    return this.config().ui.timezone;
  }

  /**
   * Reconciles what a dead process left, applies boot catch-up, and arms.
   *
   * Nothing runs before this, and a disabled scheduler stops here — the store
   * and the REST routes still work, so an operator can author jobs before
   * switching it on.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    // The zone the stored next-runs are already valid against, so the first
    // `refresh()` after boot has nothing to recompute. `#catchUp` below settles
    // them against this same value.
    this.zonedAt = this.timezone();

    const closed = this.jobs.reconcilePending(INTERRUPTED_BY_RESTART);
    if (closed > 0) {
      this.logger.warn(
        { runs: closed },
        'closed out automation runs left by a previous process',
      );
    }

    if (!this.enabled) {
      this.logger.info('scheduler is disabled in settings; no jobs will run');
      return;
    }

    this.catchUp();
    this.arm();
  }

  /**
   * Stops the timer, aborts what is running, and waits for it to settle.
   *
   * Must run **before** the hub closes: every in-flight run is driving a turn
   * through it, and pulling the hub first would leave those turns writing into
   * a store whose connection is about to go.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimer();
    for (const controller of this.inFlight.values()) controller.abort();
    await Promise.allSettled([...this.settling]);
    this.started = false;
    this.stopping = false;
  }

  /** Re-reads what is due. Called after any create, update, delete or save. */
  refresh(): void {
    if (!this.started) return;
    this.rezone();
    if (!this.enabled) {
      this.clearTimer();
      return;
    }
    this.arm();
  }

  /**
   * Recomputes cron next-runs when the install's zone changed under them.
   *
   * A cron expression is a wall-clock time, so its stored instant is only valid
   * against the zone it was computed in. Changing `ui.timezone` is therefore a
   * reschedule, and doing it here — on the `refresh()` that `settings.patch`
   * already calls — is what makes the panel's answer true immediately rather
   * than after each job happens to fire once more.
   *
   * **Cron only.** An `every` job is an interval with no wall clock in it, and
   * recomputing it would push its next run a full interval into the future on
   * every unrelated save. An `at` job is an instant that was already resolved.
   * Neither moves when the zone does.
   *
   * Guarded on an actual change rather than run unconditionally: `refresh()` is
   * called after every create, update and delete, and a rescan of every job on
   * each of those is work with no answer to give.
   */
  private rezone(): void {
    const tz = this.timezone();
    if (this.zonedAt === tz) return;
    this.zonedAt = tz;

    const now = this.clock.now();
    let moved = 0;
    for (const job of this.jobs.listJobs()) {
      if (job.schedule.kind !== 'cron' || !job.enabled) continue;
      const next = nextRunAfter(job.schedule, now, tz);
      if (next === job.state.nextRunAtMs) continue;
      this.jobs.setNextRun(job.id, next);
      moved += 1;
    }
    if (moved > 0) {
      this.logger.info(
        `Timezone is now ${tz}; rescheduled ${String(moved)} cron job(s) against it.`,
      );
    }
  }

  /**
   * Runs a job now, out of band.
   *
   * Returns the `pending` row rather than the finished one: a turn takes
   * minutes, and the REST route that calls this answers 202 so a browser is not
   * holding a request open for the length of an agent run.
   */
  runNow(jobId: string): AutomationRun {
    const job = this.jobs.getJob(jobId);
    if (job === undefined) {
      throw new GhostError(
        'not_found',
        `No automation job with id "${jobId}".`,
      );
    }
    if (this.inFlight.has(jobId)) {
      throw new GhostError('conflict', `"${job.name}" is already running.`);
    }
    return this.dispatch(job, { rearmAfter: true });
  }

  // -------------------------------------------------------------------------
  // The timer
  // -------------------------------------------------------------------------

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Schedules the next wake.
   *
   * `floorMs` is what the caller passes when the last drain left due work it
   * could not start — see `BUSY_RETRY_MS`. Without it the delay to work that is
   * already due is zero, and a saturated scheduler re-arms at zero forever.
   */
  private arm(floorMs = 0): void {
    this.clearTimer();
    if (this.stopping || !this.enabled) return;

    const at = this.jobs.earliestDueMs();
    // No timer at all when nothing is scheduled. An idle install should not be
    // waking up to discover that repeatedly.
    if (at === undefined) return;

    const delay = Math.min(
      Math.max(at - this.clock.now(), floorMs),
      MAX_ARM_MS,
    );
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.drain();
    }, delay);
  }

  /**
   * Dispatches everything due, up to the concurrency limit, then rearms.
   *
   * `concurrency` is read live on every drain, so raising it in Settings takes
   * effect on the next wake rather than the next restart.
   */
  private drain(): void {
    if (this.stopping || !this.enabled) return;

    // True when something was due and could not be started — every slot taken,
    // or the only due job is one already running. Both leave the row due, so
    // the next arm would compute a zero delay and spin.
    let blocked = false;

    const limit = this.config().scheduler.concurrency - this.inFlight.size;
    if (limit <= 0) {
      blocked = this.jobs.earliestDueMs() !== undefined;
    } else {
      for (const job of this.jobs.dueJobs(this.clock.now(), limit)) {
        // A job already running is left due rather than started twice. Its own
        // completion recomputes the next time and rearms.
        if (this.inFlight.has(job.id)) {
          blocked = true;
          continue;
        }
        this.dispatch(job, { rearmAfter: false });
      }
    }

    this.arm(blocked ? BUSY_RETRY_MS : 0);
  }

  /**
   * Boot catch-up.
   *
   * `catchUpOnBoot` coalesces rather than replaying: a job that missed twelve
   * occurrences over a weekend runs **once**, because the point of a scheduled
   * job is that the work happens, not that it happens twelve times at 9am on
   * Monday. A missed one-shot is the case the flag was written for, and turning
   * it off records the miss rather than hiding it — a reminder that silently
   * vanished is worse than one that says it was missed.
   */
  private catchUp(): void {
    const now = this.clock.now();
    const missed = this.jobs.missedJobs(now);
    if (missed.length === 0) return;

    const catchUp = this.config().scheduler.catchUpOnBoot;

    for (const job of missed) {
      if (catchUp) {
        this.dispatch(job, {
          rearmAfter: false,
          warnings: [
            `This run was started at boot: its scheduled time (${new Date(job.state.nextRunAtMs).toISOString()}) passed while the server was down.`,
          ],
        });
        continue;
      }

      if (job.schedule.kind === 'at') {
        // Recorded, not deleted: a one-shot that vanished without trace is a
        // reminder the operator never learns was missed. `deleteAfterRun` is
        // deliberately not honoured here, because it did not run.
        const run = this.jobs.startRun({ jobId: job.id });
        this.jobs.finishRun(run.id, {
          status: 'skipped',
          skipReason: 'Missed while the server was down.',
        });
        this.jobs.recordOutcome(job.id, { ranAtMs: now, status: 'skipped' });
        this.jobs.setNextRun(job.id, 0);
        continue;
      }

      this.jobs.setNextRun(
        job.id,
        nextRunAfter(job.schedule, now, this.timezone()),
      );
    }
  }

  // -------------------------------------------------------------------------
  // One run
  // -------------------------------------------------------------------------

  /**
   * Starts a run and returns its `pending` row.
   *
   * The provisional next time is written **here**, before anything can fail, so
   * a hard kill leaves the job scheduled at roughly the right moment rather
   * than unscheduled forever. Completion corrects it.
   */
  private dispatch(
    job: AutomationJob,
    options: {
      readonly rearmAfter: boolean;
      readonly warnings?: readonly string[];
    },
  ): AutomationRun {
    const now = this.clock.now();
    const run = this.jobs.startRun({
      jobId: job.id,
      // A plain id. The job it belongs to is `job_id` on this very row and the
      // origin is `sessions.origin`, so a key that spelled either out was long
      // without being more useful — nothing ever parsed it back.
      sessionKey: job.payload.sessionKey ?? this.newId(),
    });

    // A one-shot is unscheduled the instant it is dispatched. Anything else
    // gets a provisional time that completion will move.
    //
    // A *disabled* job stays unscheduled, and that is `runNow`'s doing: it is
    // the one caller that reaches a job the timer would never pick up. Writing a
    // next-run time here left a row badged Disabled with a "Next run" beside
    // it — a contradiction an operator has to work out for themselves, and a
    // stale time the job would inherit whenever it was next switched on.
    this.jobs.setNextRun(job.id, this.nextRunFor(job, now));

    const controller = new AbortController();
    this.inFlight.set(job.id, controller);

    const settled = this.execute(job, run, controller, options.warnings ?? [])
      .catch((error: unknown) => {
        this.logger.error(
          { err: error, jobId: job.id },
          'automation run failed unexpectedly',
        );
      })
      .finally(() => {
        this.inFlight.delete(job.id);
        this.settling.delete(settled);
        if (options.rearmAfter || !this.stopping) this.arm();
      });

    this.settling.add(settled);
    return run;
  }

  private async execute(
    job: AutomationJob,
    run: AutomationRun,
    controller: AbortController,
    seeded: readonly string[],
  ): Promise<void> {
    const warnings = [...seeded];
    if (job.payload.deliver) warnings.push(NO_CHANNEL_WARNING);

    let status: RunStatus = 'ok';
    let output = '';
    let error: string | undefined;
    let skipReason: string | undefined;
    let notify: { readonly title: string; readonly body: string } | undefined;

    try {
      if (job.payload.kind === 'heartbeat') {
        const decided = await this.decide(job, job.payload, controller.signal);
        warnings.push(...decided.warnings);
        if (decided.action !== 'run') {
          status = 'skipped';
          skipReason = decided.reason;
        } else {
          const turn = await this.runTurn(
            job,
            run,
            decided.instruction,
            controller,
          );
          warnings.push(...turn.warnings);
          output = turn.text;
          if (turn.error !== undefined) {
            status = 'error';
            error = turn.error;
          } else {
            const verdict = await this.evaluate(
              job,
              decided.instruction,
              turn.text,
              controller.signal,
            );
            warnings.push(...verdict.warnings);
            if (verdict.notify) {
              notify = { title: verdict.title, body: verdict.summary };
            }
          }
        }
      } else {
        const turn = await this.runTurn(
          job,
          run,
          job.payload.message,
          controller,
        );
        warnings.push(...turn.warnings);
        output = turn.text;
        if (turn.error !== undefined) {
          status = 'error';
          error = turn.error;
        } else {
          notify = {
            title: `${job.name} finished`,
            body: output.slice(0, 500),
          };
        }
      }
    } catch (caught) {
      const failure = toGhostError(caught);
      status = 'error';
      error = controller.signal.aborted
        ? INTERRUPTED_BY_SHUTDOWN
        : failure.message;
    }

    this.jobs.finishRun(run.id, {
      status,
      warnings,
      ...(output === '' ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      ...(skipReason === undefined ? {} : { skipReason }),
    });
    this.jobs.recordOutcome(job.id, {
      ranAtMs: run.startedAtMs,
      status,
      ...(error === undefined ? {} : { error }),
    });

    this.settle(job, run, status, error, notify);
  }

  /** Everything that happens once a run's outcome is written. */
  private settle(
    job: AutomationJob,
    run: AutomationRun,
    status: RunStatus,
    error: string | undefined,
    notify: { readonly title: string; readonly body: string } | undefined,
  ): void {
    if (status === 'error') {
      // An error always notifies. The evaluate step never gets to veto it: a
      // failure nobody was told about is a job that has quietly not worked for
      // a week.
      this.notify(job, run, {
        title: `${job.name} failed`,
        body: error ?? '',
        level: 'error',
      });
    } else if (notify !== undefined) {
      this.notify(job, run, {
        title: notify.title,
        body: notify.body,
        level: 'info',
      });
    }

    // Trimming here rather than on a sweep: the row that pushes the history
    // over the cap is the one that just landed.
    const trimmed = this.jobs.trimRuns(
      job.id,
      this.config().scheduler.runRetention,
    );
    for (const gone of trimmed) {
      // Only the sessions this engine minted. A `payload.sessionKey` the
      // operator chose is deliberately shared and long-lived, and deleting it
      // would take a conversation with it.
      if (gone.sessionKey === undefined) continue;
      if (job.payload.sessionKey === gone.sessionKey) continue;
      this.deleteSession?.(gone.sessionKey);
    }

    if (job.deleteAfterRun && job.schedule.kind === 'at') {
      this.jobs.deleteJob(job.id);
      return;
    }

    // The authoritative next time, now that the run's real duration is known.
    // An interval job that took longer than its interval lands in the future
    // rather than immediately due, which is what stops a slow job from
    // becoming a permanent backlog.
    if (job.schedule.kind !== 'at') {
      this.jobs.setNextRun(job.id, this.nextRunFor(job, this.clock.now()));
    }
  }

  /**
   * When this job should fire next, or 0 for "not scheduled".
   *
   * Zero for a one-shot, which has just used up its only occurrence, and zero
   * for a disabled job, which has no next occurrence at all — an on-demand run
   * must not quietly put one back on the timer's books.
   */
  private nextRunFor(job: AutomationJob, nowMs: number): number {
    if (job.schedule.kind === 'at' || !job.enabled) return 0;
    return nextRunAfter(job.schedule, nowMs, this.timezone());
  }

  private notify(
    job: AutomationJob,
    run: AutomationRun,
    input: {
      readonly title: string;
      readonly body: string;
      readonly level: Notification['level'];
    },
  ): void {
    const notification = this.raise({
      title: input.title,
      body: input.body,
      level: input.level,
      jobId: job.id,
      ...(run.sessionKey === undefined ? {} : { sessionKey: run.sessionKey }),
    });

    this.broadcast({
      type: 'notification',
      id: notification.id,
      title: notification.title,
      body: notification.body,
      level: notification.level,
      createdAtMs: notification.createdAtMs,
      jobId: job.id,
      ...(notification.sessionKey === undefined
        ? {}
        : { sessionKey: notification.sessionKey }),
    });
  }

  /**
   * Drives one turn through the hub and collects its answer.
   *
   * The timeout is not belt-and-braces: a hub-level refusal that arrives after
   * the collector has stopped listening, or a socket that never produces
   * `turn.end`, would otherwise leave the run `pending` forever with no process
   * behind it.
   */
  private async runTurn(
    job: AutomationJob,
    run: AutomationRun,
    message: string,
    controller: AbortController,
  ): Promise<TurnOutcome> {
    const collector = new TurnCollector();
    // The fallback is for a run row written before `startRun` began recording a
    // key. The job id, so such runs share one session rather than minting a
    // fresh one each time.
    const sessionKey = run.sessionKey ?? job.id;

    const connection = this.connect({
      sessionKey,
      channel: AUTOMATION_ORIGIN,
      // This connection drives the turn and collects its output; it cannot
      // answer anything. Saying so is what lets the approval gate tell an
      // unattended run from a conversation someone has open.
      unattended: true,
      send: (event) => {
        collector.receive(event);
      },
      ...(job.payload.agentId === undefined
        ? {}
        : { agentId: job.payload.agentId }),
      ...(job.payload.workspaceId === undefined
        ? {}
        : { workspaceId: job.payload.workspaceId }),
    });

    const onAbort = (): void => {
      connection.receive({ type: 'turn.stop', sessionKey });
      collector.finish(INTERRUPTED_BY_SHUTDOWN);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const timeout = this.clock.setTimeout(() => {
      connection.receive({ type: 'turn.stop', sessionKey });
      collector.finish('The run exceeded its time limit and was stopped.');
    }, this.runTimeoutMs);

    try {
      connection.receive({
        type: 'user.message',
        sessionKey,
        content: message,
        // The run id, so a redelivery is acknowledged rather than run twice.
        clientMessageId: run.id,
        ...(job.payload.agentId === undefined
          ? {}
          : { agentId: job.payload.agentId }),
      });
      return await collector.promise;
    } finally {
      this.clock.clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      connection.close();
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------------

  private async decide(
    job: AutomationJob,
    payload: Extract<AutomationPayload, { kind: 'heartbeat' }>,
    signal: AbortSignal,
  ): Promise<{
    readonly action: 'skip' | 'run';
    readonly reason: string;
    readonly instruction: string;
    readonly warnings: readonly string[];
  }> {
    const chat = this.chat;
    const readFile = this.readFile;
    if (chat === undefined || readFile === undefined) {
      // Not a silent "always run": that would start an unbounded turn on
      // whatever the file happens to say, every interval, forever.
      throw new GhostError(
        'not_found',
        'This build has no direct provider access, so a heartbeat cannot decide whether to run.',
      );
    }

    let contents: string;
    try {
      // Defaulted here rather than at each composition root, so "the job named
      // no workspace" has one answer instead of one per wiring.
      contents = await readFile({
        workspaceId: payload.workspaceId ?? DEFAULT_WORKSPACE_ID,
        path: payload.file,
        maxBytes: MAX_TASK_FILE_BYTES,
      });
    } catch (caught) {
      const failure = toGhostError(caught);
      if (failure.kind === 'not_found') {
        // A heartbeat with no task file is a normal idle state on a fresh
        // install, not a fault. It costs nothing — no provider call happens.
        return {
          action: 'skip',
          reason: `No ${payload.file} in the workspace.`,
          instruction: '',
          warnings: [],
        };
      }
      throw failure;
    }

    if (contents.trim() === '') {
      return {
        action: 'skip',
        reason: `${payload.file} is empty.`,
        instruction: '',
        warnings: [],
      };
    }

    const truncated = contents.length > MAX_TASK_FILE_BYTES;
    const result = await chat({
      messages: buildDecideMessages({
        file: payload.file,
        contents: truncated ? contents.slice(0, MAX_TASK_FILE_BYTES) : contents,
        nowIso: new Date(this.clock.now()).toISOString(),
      }),
      tools: [HEARTBEAT_TOOL],
      toolChoice: 'required',
      maxTokens: 256,
      signal,
      ...(payload.model === undefined ? {} : { model: payload.model }),
      ...(payload.agentId === undefined ? {} : { agentId: payload.agentId }),
    });

    const decision = readDecision(result, payload.file);
    this.logger.debug(
      { jobId: job.id, action: decision.action, reason: decision.reason },
      'heartbeat decision',
    );
    return {
      ...decision,
      warnings: truncated
        ? [
            ...decision.warnings,
            `${payload.file} was truncated before the model read it.`,
          ]
        : decision.warnings,
    };
  }

  private async evaluate(
    job: AutomationJob,
    instruction: string,
    output: string,
    signal: AbortSignal,
  ): Promise<{
    readonly notify: boolean;
    readonly title: string;
    readonly summary: string;
    readonly warnings: readonly string[];
  }> {
    const chat = this.chat;
    if (chat === undefined) {
      return {
        notify: true,
        title: `${job.name} finished`,
        summary: output.slice(0, 500),
        warnings: [],
      };
    }

    const payload = job.payload;
    const result = await chat({
      messages: buildEvaluateMessages({ instruction, output }),
      tools: [HEARTBEAT_RESULT_TOOL],
      toolChoice: 'required',
      maxTokens: 256,
      signal,
      ...(payload.kind === 'heartbeat' && payload.model !== undefined
        ? { model: payload.model }
        : {}),
      ...(payload.agentId === undefined ? {} : { agentId: payload.agentId }),
    });

    return readEvaluation(result, `${job.name} finished`);
  }
}
