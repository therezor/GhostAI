/**
 * Scheduled jobs over REST.
 *
 * Two things here are not the obvious choice.
 *
 * **`automation.run` answers 202 with a `pending` run**, not 200 with the
 * result. A turn takes minutes; a handler that awaited one would hold a browser
 * request open past every timeout between them. The client watches the run
 * list, which the `notification` frame tells it to refresh — and which is also
 * what keeps the e2e spec inside the rule about never asserting a transient
 * state.
 *
 * **A bad cron expression is a 422 naming the field.** `parseCron` throws
 * `GhostError('config')`, and the default mapping for `config` is a 500,
 * because a config error normally means *this install* is broken. Here it means
 * the operator typed something in a form, so it is caught and re-thrown as the
 * validation failure it actually is.
 */

import {
  AutomationJobListResponseSchema,
  AutomationJobSchema,
  AutomationRunListResponseSchema,
  AutomationRunSchema,
  CreateAutomationJobSchema,
  UpdateAutomationJobSchema,
  type AutomationJob,
  type AutomationJobListResponse,
  type AutomationRun,
  type AutomationRunListResponse,
  type AutomationSchedule,
  type CreateAutomationJob,
  type UpdateAutomationJob,
} from '@ghostai/protocol';
import { isGhostError } from '@ghostai/core';
import type { FastifyReply } from 'fastify';

import { decodeAutomationRunCursor, encodeAutomationRunCursor } from '../cursor.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { IdParamsSchema, PageQuerySchema, type IdParams, type PageQuery } from '../queries.js';
import { firstRunAt } from '../scheduler.js';
import type { RouteDeps, RouteGroup } from './types.js';

type AutomationRouteId =
  | 'automation.list'
  | 'automation.create'
  | 'automation.get'
  | 'automation.update'
  | 'automation.delete'
  | 'automation.run'
  | 'automation.runs';

/**
 * Validates a schedule by asking it when it would next fire.
 *
 * Cheaper than a second validator and impossible to drift from one: whatever
 * the engine will do with this schedule is exactly what runs here, so an
 * expression the timer could not honour cannot be saved.
 */
function nextRunOrRefuse(
  schedule: AutomationSchedule,
  nowMs: number,
  enabled: boolean,
  tz: string,
): number {
  try {
    return firstRunAt(schedule, nowMs, enabled, tz);
  } catch (error) {
    if (isGhostError(error) && error.kind === 'config') {
      throw unprocessable(error.message, { '/schedule': error.message });
    }
    throw error;
  }
}

export function automationRoutes(deps: RouteDeps): RouteGroup<AutomationRouteId> {
  const store = deps.automation;
  const now = (): number => deps.clock?.now() ?? Date.now();
  // Live, so a zone changed in Appearance applies to the next job saved rather
  // than to the next restart.
  const timezone = (): string => deps.runtime.config().ui.timezone;

  /** The engine, or a refusal naming which of the two reasons it is missing. */
  const requireScheduler = (): NonNullable<ReturnType<NonNullable<RouteDeps['scheduler']>>> => {
    const scheduler = deps.scheduler?.();
    if (scheduler === undefined) {
      throw notFound('This build has no scheduler, so a job cannot be run on demand.');
    }
    if (!scheduler.enabled) {
      // Not a 404: the route exists and the job exists. The operator turned the
      // engine off, and saying so is what lets them turn it back on.
      throw unprocessable('The scheduler is disabled in settings.', {
        '/scheduler/enabled': 'The scheduler is disabled in settings.',
      });
    }
    return scheduler;
  };

  return {
    'automation.list': {
      summary: 'Every scheduled job',
      schema: { response: { 200: AutomationJobListResponseSchema } },
      handler: (): AutomationJobListResponse => ({ jobs: store.listJobs() }),
    },

    'automation.create': {
      summary: 'Create a scheduled job',
      schema: { body: CreateAutomationJobSchema, response: { 201: AutomationJobSchema } },
      handler: (request, reply): FastifyReply => {
        const body = request.body as CreateAutomationJob;
        const created = store.createJob({
          name: body.name,
          schedule: body.schedule,
          payload: body.payload,
          enabled: body.enabled,
          deleteAfterRun: body.deleteAfterRun,
          nextRunAtMs: nextRunOrRefuse(body.schedule, now(), body.enabled, timezone()),
        });
        deps.scheduler?.()?.refresh();
        return reply.status(201).send(created);
      },
    },

    'automation.get': {
      summary: 'One scheduled job',
      schema: { params: IdParamsSchema, response: { 200: AutomationJobSchema } },
      handler: (request): AutomationJob => {
        const { id } = request.params as IdParams;
        const job = store.getJob(id);
        if (job === undefined) throw notFound(`No automation job "${id}"`);
        return job;
      },
    },

    'automation.update': {
      summary: 'Change a scheduled job',
      schema: {
        params: IdParamsSchema,
        body: UpdateAutomationJobSchema,
        response: { 200: AutomationJobSchema },
      },
      handler: (request): AutomationJob => {
        const { id } = request.params as IdParams;
        const body = request.body as UpdateAutomationJob;
        const existing = store.getJob(id);
        if (existing === undefined) throw notFound(`No automation job "${id}"`);

        // Recomputed whenever either half of "when does this fire" moves.
        // Leaving the old instant behind is how a job edited to run at 9am
        // keeps firing at 3am until it happens to be restarted.
        const schedule = body.schedule ?? existing.schedule;
        const enabled = body.enabled ?? existing.enabled;
        const rescheduled = body.schedule !== undefined || body.enabled !== undefined;

        const updated = store.updateJob(id, {
          ...body,
          ...(rescheduled
            ? { nextRunAtMs: nextRunOrRefuse(schedule, now(), enabled, timezone()) }
            : {}),
        });
        if (updated === undefined) throw notFound(`No automation job "${id}"`);
        deps.scheduler?.()?.refresh();
        return updated;
      },
    },

    'automation.delete': {
      summary: 'Delete a scheduled job and its history',
      schema: { params: IdParamsSchema },
      handler: (request, reply): FastifyReply => {
        const { id } = request.params as IdParams;
        if (!store.deleteJob(id)) throw notFound(`No automation job "${id}"`);
        deps.scheduler?.()?.refresh();
        return reply.status(204).send();
      },
    },

    'automation.run': {
      summary: 'Run a scheduled job now',
      // The one route where a single HTTP call starts an unbounded agent turn.
      rateLimit: { max: 30, timeWindowMs: 60_000 },
      schema: { params: IdParamsSchema, response: { 202: AutomationRunSchema } },
      handler: (request, reply): FastifyReply => {
        const { id } = request.params as IdParams;
        if (store.getJob(id) === undefined) throw notFound(`No automation job "${id}"`);
        const scheduler = requireScheduler();
        try {
          // 202: the run has started, and its answer is minutes away. The
          // client follows the run list rather than holding a socket open.
          return reply.status(202).send(scheduler.runNow(id));
        } catch (error) {
          if (isGhostError(error) && error.kind === 'conflict') {
            throw conflict(error.message);
          }
          throw error;
        }
      },
    },

    'automation.runs': {
      summary: 'One job′s run history, newest first',
      schema: {
        params: IdParamsSchema,
        querystring: PageQuerySchema,
        response: { 200: AutomationRunListResponseSchema },
      },
      handler: (request): AutomationRunListResponse => {
        const { id } = request.params as IdParams;
        if (store.getJob(id) === undefined) throw notFound(`No automation job "${id}"`);
        const query = request.query as PageQuery;

        // One more than asked for, so "is there another page" is answered by
        // what came back rather than by a second count query.
        const rows: AutomationRun[] = store.listRuns(id, {
          limit: query.limit + 1,
          ...(query.cursor === undefined ? {} : { after: decodeAutomationRunCursor(query.cursor) }),
        });

        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        return {
          runs: page,
          ...(rows.length > query.limit && last !== undefined
            ? {
                nextCursor: encodeAutomationRunCursor({
                  startedAtMs: last.startedAtMs,
                  id: last.id,
                }),
              }
            : {}),
        };
      },
    },
  };
}
