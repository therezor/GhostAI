/**
 * Slash commands: everything the web UI grew, at a prompt.
 *
 * The CLI and the browser share one SQLite file, so a conversation started here
 * is the same row the sidebar lists. What was missing was not plumbing — it was
 * a way to *say* any of it from a terminal, and the primitives are the same ones
 * the routes call. Nothing here reimplements truncation, forking or context
 * measurement; it names them.
 *
 * Two shapes carry the design.
 *
 * **`SlashOutcome` rather than a boolean.** The old dispatcher returned "should
 * the REPL exit", which was enough when the only commands were `/clear` and
 * `/help`. `/new`, `/session <key>` and `/branch` all change *which conversation
 * the prompt is attached to*, and `/edit` and `/regenerate` end by wanting a
 * turn run. Both are answers a boolean cannot express.
 *
 * **`/edit` and `/regenerate` hand content back rather than running it.** They
 * truncate, then return `{ kind: 'turn' }`, and the REPL runs it through the
 * same path a typed message takes. One turn-running code path in the CLI —
 * exactly as the hub has one — so a re-run inherits the renderer, the abort
 * handling and the exit codes rather than a second copy of them.
 *
 * **Copy is deliberately absent.** A terminal has no portable clipboard, and
 * shelling out to `pbcopy`/`xclip`/`clip.exe` would put platform detection and a
 * `child_process` spawn into a package that has neither — which `@ghostai/core`
 * bans below `@ghostai/security` for exactly this class of convenience. A
 * terminal's selection *is* its copy mechanism.
 */

import { describeContext, type ContextReport } from '@ghostai/agent';
import {
  GhostError,
  isGhostError,
  textOf,
  type SessionStore,
} from '@ghostai/core';
import { formatNumber } from '@ghostai/i18n';
import { newUuid, type ContentPart } from '@ghostai/protocol';

import type { CliKey, CliT } from './i18n.js';
import {
  recentMessages,
  resolveSeq,
  DEFAULT_MESSAGE_LINES,
} from './messages.js';
import type { TurnRenderer } from './render.js';
import type { ChatRuntime } from './runtime.js';

/** What a slash command asks the REPL to do next. */
export type SlashOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'exit' }
  /** Attach the prompt to another conversation. */
  | { readonly kind: 'attach'; readonly sessionKey: string }
  /** Run this content as a turn, through the REPL's own path. */
  | {
      readonly kind: 'turn';
      readonly content: string | readonly ContentPart[];
    };

const CONTINUE: SlashOutcome = { kind: 'continue' };

export interface SlashContext {
  readonly renderer: TurnRenderer;
  readonly runtime: ChatRuntime;
  /** The terminal's `t`, scoped to the `cli` bundle. */
  readonly t: CliT;
  /** The resolved locale, for the numbers `t` does not format. */
  readonly locale: string;
  /** Read at call time: the REPL's attachment moves. */
  readonly sessionKey: string;
  /** Where a *new* conversation lands. `undefined` means the default. */
  readonly workspaceId: string | undefined;
  readonly setWorkspace: (id: string | undefined) => void;
}

/**
 * One row of `/help`: what you type, and what it does.
 *
 * The two halves are kept apart because only one of them is language.
 * `/workspace move <from> <to>` is *syntax* — it is what the parser above
 * matches on, so translating it would print a command that does not exist. The
 * description beside it is prose and belongs in the resources.
 */
interface HelpRow {
  /** Typed by the user, so never translated. */
  readonly syntax: string;
  /** Absent for a variant row that the row above it already described. */
  readonly key?: CliKey;
}

interface HelpSection {
  /** Absent for the opening rows, which sit above the first heading. */
  readonly heading?: CliKey;
  readonly rows: readonly HelpRow[];
}

const HELP_LAYOUT: readonly HelpSection[] = [
  {
    rows: [
      { syntax: '/help', key: 'slash.help.help' },
      { syntax: '/messages [n]', key: 'slash.help.messages' },
      { syntax: '/clear', key: 'slash.help.clear' },
      { syntax: '/exit, /quit', key: 'slash.help.exit' },
    ],
  },
  {
    heading: 'slash.sections.sessions',
    rows: [
      { syntax: '/sessions [n]', key: 'slash.help.sessions' },
      { syntax: '/new [title]', key: 'slash.help.new' },
      { syntax: '/session [key]', key: 'slash.help.session' },
      { syntax: '/rename <title>', key: 'slash.help.rename' },
      { syntax: '/delete [key]', key: 'slash.help.delete' },
      { syntax: '/branch [ref]', key: 'slash.help.branch' },
    ],
  },
  {
    heading: 'slash.sections.messages',
    rows: [
      { syntax: '/edit <ref> <text>', key: 'slash.help.edit' },
      { syntax: '/regenerate [ref]', key: 'slash.help.regenerate' },
    ],
  },
  {
    heading: 'slash.sections.context',
    rows: [
      { syntax: '/context', key: 'slash.help.context' },
      { syntax: '/stats [n]', key: 'slash.help.stats' },
    ],
  },
  {
    heading: 'slash.sections.workspaces',
    rows: [
      { syntax: '/workspaces', key: 'slash.help.workspaces' },
      { syntax: '/workspace <id>', key: 'slash.help.workspace' },
      { syntax: '/workspace new <name>' },
      { syntax: '/workspace rename <id> <name>' },
      { syntax: '/workspace rm <id>', key: 'slash.help.workspaceRm' },
      {
        syntax: '/workspace move <from> <to>',
        key: 'slash.help.workspaceMove',
      },
    ],
  },
];

/**
 * The `/help` listing, measured rather than typed out.
 *
 * This replaced a 31-line template literal whose description column was a run of
 * spaces someone counted by hand. That held only while every description was
 * English — the first German string would have pushed its own row out and left
 * the other twenty where they were — and it was already two characters out on
 * the opening row before any of this. `serve.ts`'s banner has derived its column
 * from the longest label all along, for the same reason.
 *
 * The width is measured over the rows that *have* a description, so the two
 * variant rows that carry none cannot push the column right for everybody else.
 */
export function helpText(t: CliT): string {
  const width = Math.max(
    ...HELP_LAYOUT.flatMap((section) =>
      section.rows
        .filter((row) => row.key !== undefined)
        .map((row) => row.syntax.length),
    ),
  );

  const blocks = HELP_LAYOUT.map((section) => {
    const rows = section.rows
      .map((row) =>
        row.key === undefined
          ? `  ${row.syntax}`
          : `  ${row.syntax.padEnd(width)}  ${t(row.key)}`,
      )
      .join('\n');

    return section.heading === undefined
      ? rows
      : `  ${t(section.heading)}\n${rows}`;
  });

  return `${blocks.join('\n\n')}\n\n  ${t('slash.refNote')}`;
}

/**
 * Runs one slash command.
 *
 * Never throws for anything a user typed: a `GhostError` from a primitive is
 * rendered as a warning and the prompt comes back. A REPL that exits on a
 * mistyped session key would be worse than the mistyped key.
 */
export async function runSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<SlashOutcome> {
  const [word = input, ...rest] = input.trim().split(/\s+/u);
  const name = word.slice(1);
  const argv = rest;
  const tail = input.trim().slice(word.length).trim();

  try {
    return await dispatch(name, argv, tail, ctx);
  } catch (error) {
    if (isGhostError(error)) {
      ctx.renderer.warn(error.message);
      return CONTINUE;
    }
    throw error;
  }
}

async function dispatch(
  name: string,
  argv: readonly string[],
  tail: string,
  ctx: SlashContext,
): Promise<SlashOutcome> {
  const { renderer, runtime, t } = ctx;
  const store = runtime.store;

  switch (name) {
    case 'exit':
    case 'quit':
      return { kind: 'exit' };

    case 'help':
      renderer.note(helpText(ctx.t));
      return CONTINUE;

    case 'clear':
      store.clearMessages(ctx.sessionKey);
      renderer.note(t('slash.notes.historyCleared'));
      return CONTINUE;

    case 'messages': {
      const count = positiveCount(argv[0]) ?? DEFAULT_MESSAGE_LINES;
      const rows = recentMessages(store, ctx.sessionKey, count);
      if (rows.length === 0) {
        renderer.note(t('slash.notes.nothingSaid'));
        return CONTINUE;
      }
      renderer.note(
        rows
          .map((row) => `${pad(row.seq)}  ${row.role}  ${clip(row.text)}`)
          .join('\n'),
      );
      return CONTINUE;
    }

    // ── Sessions ──────────────────────────────────────────────

    case 'sessions': {
      const limit = positiveCount(argv[0]) ?? 20;
      const workspaceId = store.getSession(ctx.sessionKey)?.workspaceId;
      const rows = store.listSessions({
        limit,
        ...(workspaceId === undefined ? {} : { workspaceId }),
      });
      if (rows.length === 0) {
        renderer.note(t('slash.notes.noSessions'));
        return CONTINUE;
      }
      renderer.note(
        rows
          .map((row) => {
            const mark = row.key === ctx.sessionKey ? '*' : ' ';
            const title = row.title === '' ? '(unnamed)' : row.title;
            return `${mark} ${title}  ·  ${row.key}  ·  ${String(row.messageCount)} messages`;
          })
          .join('\n'),
      );
      return CONTINUE;
    }

    case 'new': {
      const key = `cli-${randomKey()}`;
      store.ensureSession(key, {
        origin: 'cli',
        ...(tail === '' ? {} : { title: tail }),
        ...(ctx.workspaceId === undefined
          ? {}
          : { workspaceId: ctx.workspaceId }),
      });
      return { kind: 'attach', sessionKey: key };
    }

    case 'session': {
      const target = argv[0];
      if (target === undefined) {
        const session = store.getSession(ctx.sessionKey);
        const title =
          session === undefined || session.title === ''
            ? '(unnamed)'
            : session.title;
        // The session's *own* workspace, not the pending one. They differ after
        // a `/workspace` switch, and showing the pending one here would report
        // where the next conversation lands as though it were where this one is.
        const workspace = session?.workspaceId ?? '—';
        renderer.note(
          `${title}\n  ${ctx.sessionKey}  ·  ${String(store.messageCount(ctx.sessionKey))} messages  ·  workspace ${workspace}`,
        );
        return CONTINUE;
      }
      store.ensureSession(target, { origin: 'cli' });
      return { kind: 'attach', sessionKey: target };
    }

    case 'rename': {
      if (tail === '') {
        throw new GhostError('invalid_input', t('slash.errors.usageRename'));
      }
      store.updateSession(ctx.sessionKey, { title: tail });
      renderer.note(t('slash.notes.renamedTo', { title: tail }));
      return CONTINUE;
    }

    case 'delete': {
      const key = argv[0] ?? ctx.sessionKey;
      if (!store.deleteSession(key)) {
        throw new GhostError('not_found', t('slash.errors.noSession', { key }));
      }
      renderer.note(t('slash.notes.deleted', { key }));
      if (key !== ctx.sessionKey) return CONTINUE;
      // The one it was attached to is gone, so it needs somewhere to be.
      const next = `cli-${randomKey()}`;
      store.ensureSession(next, { origin: 'cli' });
      return { kind: 'attach', sessionKey: next };
    }

    case 'branch': {
      const seq = resolveSeq(store, ctx.sessionKey, argv[0]);
      const fork = store.forkSession(ctx.sessionKey, seq, { origin: 'cli' });
      renderer.note(
        `branched at ${String(fork.seq)} · ${String(fork.copied)} messages · ${fork.session.key}`,
      );
      return { kind: 'attach', sessionKey: fork.session.key };
    }

    // ── Messages ──────────────────────────────────────────────

    case 'edit': {
      const ref = argv[0];
      const text = tail.slice(ref?.length ?? 0).trim();
      if (ref === undefined || text === '') {
        throw new GhostError('invalid_input', t('slash.errors.usageEdit'));
      }
      const seq = requireUserMessage(
        store,
        ctx.sessionKey,
        resolveSeq(store, ctx.sessionKey, ref),
        t,
      );
      // Below the edited message: the loop appends the replacement itself, so
      // cutting *at* it would leave the old wording above the new one.
      store.truncateAfter(ctx.sessionKey, seq - 1);
      return { kind: 'turn', content: text };
    }

    case 'regenerate': {
      const seq = requireUserMessage(
        store,
        ctx.sessionKey,
        resolveSeq(store, ctx.sessionKey, argv[0]),
        t,
      );
      const [record] = store.messages(ctx.sessionKey, {
        afterSeq: seq - 1,
        beforeSeq: seq + 1,
      });
      if (record === undefined) {
        throw new GhostError('not_found', t('slash.errors.messageGone'));
      }
      const content = textOf(record.message);
      // Minus one, and for the same reason as the hub's: `AgentLoop.run`
      // appends the question unconditionally, so truncating *to* `seq` and
      // re-running would write it twice.
      store.truncateAfter(ctx.sessionKey, seq - 1);
      return { kind: 'turn', content };
    }

    // ── Context and cost ──────────────────────────────────────

    case 'context': {
      const loop = runtime.requireLoop();
      const report = await describeContext({
        store,
        loop,
        tools: runtime.tools.definitions(),
        sessionKey: ctx.sessionKey,
        channel: 'cli',
        contextWindowTokens: runtime.config.agents.defaults.contextWindowTokens,
      });
      if (report === undefined) {
        renderer.note(t('slash.notes.nothingToMeasure'));
        return CONTINUE;
      }
      renderer.note(formatContext(report, ctx.locale));
      return CONTINUE;
    }

    case 'stats': {
      const limit = positiveCount(argv[0]) ?? 10;
      const rows = store.turnStats(ctx.sessionKey, { limit });
      if (rows.length === 0) {
        renderer.note(t('slash.notes.noTurns'));
        return CONTINUE;
      }
      renderer.stats(rows);
      return CONTINUE;
    }

    // ── Workspaces ────────────────────────────────────────────

    case 'workspaces': {
      const current =
        ctx.workspaceId ?? store.getSession(ctx.sessionKey)?.workspaceId;
      renderer.note(
        runtime.workspaces
          .list()
          .map((workspace) => {
            const mark = workspace.id === current ? '*' : ' ';
            const count = store.countByWorkspace(workspace.id);
            return `${mark} ${workspace.id}  ·  ${workspace.name}  ·  ${String(count)} sessions`;
          })
          .join('\n'),
      );
      return CONTINUE;
    }

    case 'workspace':
      return workspaceCommand(argv, ctx);

    default:
      renderer.warn(t('slash.notes.unknownCommand', { name }));
      return CONTINUE;
  }
}

function workspaceCommand(
  argv: readonly string[],
  ctx: SlashContext,
): SlashOutcome {
  const { renderer, runtime, t } = ctx;
  const [verb, ...rest] = argv;

  switch (verb) {
    case undefined: {
      const pending = ctx.workspaceId ?? 'default';
      renderer.note(t('slash.notes.landIn', { workspace: pending }));
      return CONTINUE;
    }

    case 'new': {
      const name = rest.join(' ').trim();
      if (name === '') {
        throw new GhostError(
          'invalid_input',
          t('slash.errors.usageWorkspaceNew'),
        );
      }
      const created = runtime.workspaces.create({ name });
      renderer.note(t('slash.notes.created', { id: created.id }));
      return CONTINUE;
    }

    case 'rename': {
      const [id, ...words] = rest;
      const name = words.join(' ').trim();
      if (id === undefined || name === '') {
        throw new GhostError(
          'invalid_input',
          t('slash.errors.usageWorkspaceRename'),
        );
      }
      runtime.workspaces.rename(id, name);
      renderer.note(t('slash.notes.renamedWorkspace', { id, name }));
      return CONTINUE;
    }

    case 'rm': {
      const id = rest[0];
      if (id === undefined) {
        throw new GhostError(
          'invalid_input',
          t('slash.errors.usageWorkspaceRm'),
        );
      }
      // The same refusal the web manager makes, and for the same reason: a
      // detached workspace whose conversations still name it would leave them
      // resolving to files nothing lists. Two explicit steps, not one silent one.
      const count = runtime.store.countByWorkspace(id);
      if (count > 0) {
        throw new GhostError(
          'conflict',
          t('slash.errors.workspaceInUse', { count, id }),
        );
      }
      runtime.workspaces.delete(id);
      renderer.note(t('slash.notes.detached', { id }));
      if (ctx.workspaceId === id) ctx.setWorkspace(undefined);
      return CONTINUE;
    }

    case 'move': {
      const [from, to] = rest;
      if (from === undefined || to === undefined) {
        throw new GhostError(
          'invalid_input',
          t('slash.errors.usageWorkspaceMove'),
        );
      }
      if (runtime.workspaces.get(to) === undefined) {
        throw new GhostError(
          'not_found',
          t('slash.errors.noWorkspace', { id: to }),
        );
      }
      const moved = runtime.store.reassignWorkspace(from, to);
      renderer.note(t('slash.notes.moved', { count: moved, from, to }));
      return CONTINUE;
    }

    default: {
      // Not a verb, so it is an id: `/workspace <id>` switches.
      if (runtime.workspaces.get(verb) === undefined) {
        throw new GhostError(
          'not_found',
          t('slash.errors.noWorkspace', { id: verb }),
        );
      }
      ctx.setWorkspace(verb);

      // A conversation that exists moves with the switch; one nobody has spoken
      // in has no row to move, and the choice is only where it will land.
      //
      // The `getSession` guard is load-bearing: `updateSession` calls
      // `ensureSession` internally, so patching an unspoken session would mint
      // an empty row for it — which is what makes it show up in the sidebar.
      if (runtime.store.getSession(ctx.sessionKey) === undefined) {
        renderer.note(t('slash.notes.willLandIn', { workspace: verb }));
        return CONTINUE;
      }
      runtime.store.updateSession(ctx.sessionKey, { workspaceId: verb });
      renderer.note(t('slash.notes.movedSession', { workspace: verb }));
      return CONTINUE;
    }
  }
}

/** Only a message the user wrote can be edited or re-run. */
function requireUserMessage(
  store: SessionStore,
  sessionKey: string,
  seq: number,
  t: CliT,
): number {
  const [record] = store.messages(sessionKey, {
    afterSeq: seq - 1,
    beforeSeq: seq + 1,
  });
  if (record?.message.role !== 'user') {
    throw new GhostError('invalid_input', t('slash.errors.notYours', { seq }));
  }
  return seq;
}

/**
 * The `/context` breakdown.
 *
 * `formatNumber` with the locale passed in, rather than the bare
 * `toLocaleString()` this used to call. That was the mirror image of the bug the
 * web's `formatTokens` was working around: the web hand-rolled its grouping to
 * escape the machine's locale, and this one simply inherited it — so `/context`
 * already printed `8.192` on a machine set to `de-DE` while the same number in
 * the browser printed `8,192`. One install, two answers.
 */
function formatContext(report: ContextReport, locale: string): string {
  const percent = Math.round(
    (report.estimatedTokens / report.contextWindowTokens) * 100,
  );
  const n = (value: number): string => formatNumber(value, locale);
  // Named rather than iterated: the sections are a fixed set with a meaningful
  // order, and `Object.entries` would print them in whatever order the object
  // happens to hold while typing each value as `any`.
  const { systemPrompt, tools, messages, runtimeBlock } = report.breakdown;
  return [
    `${n(report.estimatedTokens)} of ${n(report.contextWindowTokens)} tokens · ${String(percent)}%`,
    `  ${'system'.padEnd(10)}${n(systemPrompt)}`,
    `  ${'tools'.padEnd(10)}${n(tools)}`,
    `  ${'messages'.padEnd(10)}${n(messages)}`,
    // Last because it is last in the request, and called out because it is the
    // only one of the four paid again on every step of a turn.
    `  ${'live'.padEnd(10)}${n(runtimeBlock)} (per step)`,
    `  ${'in window'.padEnd(10)}${String(report.messages.length)} messages`,
  ].join('\n');
}

function positiveCount(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function pad(seq: number): string {
  return String(seq).padStart(4, ' ');
}

function clip(text: string, max = 72): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** The same shape the REST create route mints: an origin and a uuid. */
function randomKey(): string {
  return newUuid();
}
