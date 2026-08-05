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
  DEFAULT_AGENT_ID,
  DEFAULT_WORKSPACE_ID,
  GhostError,
  MEMORY_DIRNAME,
  isGhostError,
  readMemories,
  textOf,
  type SessionStore,
} from '@ghostai/core';
import { estimateTokens } from '@ghostai/providers';
import { formatNumber } from '@ghostai/i18n';
import { newUuid, type ContentPart } from '@ghostai/protocol';

import type { CliKey, CliT } from './i18n.js';
import type { Menu } from './menu.js';
import {
  recentMessages,
  resolveSeq,
  DEFAULT_MESSAGE_LINES,
} from './messages.js';
import type { ModelCatalogue } from './models.js';
import { agentListing, pickAgent } from './pickers/agents.js';
import { modelErrors, modelListing, pickModel } from './pickers/models.js';
import { pickSession } from './pickers/sessions.js';
import { pickWorkspace } from './pickers/workspaces.js';
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
  /** Which agent a *new* conversation runs on. `undefined` is the default. */
  readonly agentId: string | undefined;
  readonly setAgent: (id: string | undefined) => void;
  /**
   * How a command asks a question with arrow keys.
   *
   * `NO_MENU` on a pipe, under `--json` and on a dumb terminal, so a command
   * that wants to offer a picker asks `menu.available` rather than working out
   * for itself whether this is a terminal.
   */
  readonly menu: Menu;
  /** What models the configured endpoints answered with, when asked. */
  readonly models: ModelCatalogue;
  /**
   * Whether `--model` pinned the model for this process.
   *
   * `RuntimeOptions.model` is documented as a statement about *this process*
   * that the config cannot move, so `/model` would appear to work and change
   * nothing. It refuses instead, naming the flag.
   */
  readonly modelPinned: boolean;
}

/**
 * One row of `/help`: what you type, and what it does.
 *
 * The two halves are kept apart because only one of them is language.
 * `/workspace move <from> <to>` is *syntax* — it is what the parser above
 * matches on, so translating it would print a command that does not exist. The
 * description beside it is prose and belongs in the resources.
 */
export interface CommandRow {
  /** Typed by the user, so never translated. */
  readonly syntax: string;
  /** Absent for a variant row that the row above it already described. */
  readonly key?: CliKey | undefined;
}

interface HelpSection {
  /** Absent for the opening rows, which sit above the first heading. */
  readonly heading?: CliKey;
  readonly rows: readonly CommandRow[];
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
    heading: 'slash.sections.output',
    rows: [
      { syntax: '/output', key: 'slash.help.output' },
      { syntax: '/output <field> [on|off]', key: 'slash.help.outputSet' },
    ],
  },
  {
    heading: 'slash.sections.agents',
    rows: [
      { syntax: '/agent [id]', key: 'slash.help.agent' },
      { syntax: '/model [id]', key: 'slash.help.model' },
    ],
  },
  {
    heading: 'slash.sections.memory',
    rows: [
      { syntax: '/memory', key: 'slash.help.memory' },
      { syntax: '/memory on|off', key: 'slash.help.memoryOnOff' },
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
/**
 * Every command, flattened out of the sections `/help` groups them into.
 *
 * Exported so the palette and the Tab completer read the same table this page
 * does. One table means a command cannot exist in one and not the other, which
 * is the failure a second list beside this one would eventually produce.
 */
export function commandRows(): readonly CommandRow[] {
  return HELP_LAYOUT.flatMap((section) => section.rows);
}

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

      // A picker on a terminal, the listing on a pipe — the same shape `/agent`
      // and `/workspace` take. The argument is the page size either way, so a
      // script and a person are asking the same question of the same rows.
      if (ctx.menu.available) {
        const target = await pickSession({
          menu: ctx.menu,
          sessions: rows,
          current: ctx.sessionKey,
          t,
        });
        if (target === undefined) return CONTINUE;
        store.ensureSession(target, { origin: 'cli' });
        return { kind: 'attach', sessionKey: target };
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

    case 'memory':
      return await memoryCommand(argv, ctx);

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
      return await workspaceCommand(argv, ctx);

    // ── Agents ────────────────────────────────────────────────

    case 'agent':
      return await agentCommand(argv[0], ctx);

    case 'model':
      return await modelCommand(argv[0], ctx);

    // ── What a turn shows ─────────────────────────────────────

    case 'output':
      return outputCommand(argv[0], argv[1], ctx);

    default:
      renderer.warn(t('slash.notes.unknownCommand', { name }));
      return CONTINUE;
  }
}

/**
 * The parts of a turn that can be turned off, and how to read each one.
 *
 * A table rather than a `switch`, because `/output` with no argument has to
 * list them — and a listing derived from the same place the command reads
 * cannot go out of step with what the command accepts.
 *
 * The names are what an operator types, so they are syntax and not prose, and
 * they are the left column of that listing for the same reason `/workspace
 * move` is never translated.
 */
const OUTPUT_FIELDS: ReadonlyArray<{
  readonly name: string;
  readonly shown: (renderer: TurnRenderer) => boolean;
  readonly set: (renderer: TurnRenderer, on: boolean) => void;
}> = [
  {
    name: 'reasoning',
    shown: (renderer) => renderer.reasoningShown,
    set: (renderer, on) => {
      renderer.setReasoningShown(on);
    },
  },
  {
    name: 'stats',
    shown: (renderer) => renderer.statsShown,
    set: (renderer, on) => {
      renderer.setStatsShown(on);
    },
  },
];

/**
 * `/output` — what a turn prints, and what it does not.
 *
 * One command rather than one per switch. The next thing worth hiding is then a
 * row in the table above rather than a new verb, a new help line and a new pair
 * of keys — and the bare form listing what is on is what makes the switches
 * discoverable at all, which two separate commands never were.
 *
 * `stats` and not `usage`: `Usage` is the token record the protocol carries,
 * and this is the *line*, which nobody at a prompt calls usage.
 *
 * Naming a field with no word flips it, which is what a hand reaching for a
 * switch expects; `on` and `off` say it outright, for one that has lost track.
 * The setting lasts as long as the process: `--no-reasoning` is how a script
 * says it once, and a prompt asking to see less for the next few turns has not
 * made a decision worth writing to `config.json`.
 */
function outputCommand(
  field: string | undefined,
  word: string | undefined,
  ctx: SlashContext,
): SlashOutcome {
  const { renderer, t } = ctx;

  if (field === undefined) {
    const column = Math.max(...OUTPUT_FIELDS.map((one) => one.name.length));
    renderer.note(
      OUTPUT_FIELDS.map(
        (one) =>
          `  ${one.name.padEnd(column)}  ${t(
            one.shown(renderer) ? 'slash.notes.shown' : 'slash.notes.hidden',
          )}`,
      ).join('\n'),
    );
    return CONTINUE;
  }

  const found = OUTPUT_FIELDS.find((one) => one.name === field);
  if (found === undefined) {
    throw new GhostError(
      'invalid_input',
      t('slash.errors.noOutputField', { field }),
    );
  }

  const wanted =
    word === 'on' ? true : word === 'off' ? false : !found.shown(renderer);
  found.set(renderer, wanted);
  renderer.note(
    t(wanted ? 'slash.notes.outputShown' : 'slash.notes.outputHidden', {
      field,
    }),
  );
  return CONTINUE;
}

/**
 * `/agent` — show them, or move this conversation onto one.
 *
 * The same decision `/workspace <id>` makes, with the nouns changed, and that is
 * the argument for it reading the same way: both answer "which of these does the
 * next turn belong to", and a reader who has understood one has understood both.
 *
 * With no argument this opens a picker on a terminal and prints a listing
 * anywhere else — so a pipe still gets an answer, and the answer it gets is the
 * one a human would have read off the menu. A cancelled picker falls through to
 * the same listing rather than to silence.
 */
async function agentCommand(
  id: string | undefined,
  ctx: SlashContext,
): Promise<SlashOutcome> {
  const { renderer, runtime, t } = ctx;
  const current =
    runtime.store.getSession(ctx.sessionKey)?.agentId ?? ctx.agentId;

  const chosen =
    id ??
    (ctx.menu.available
      ? await pickAgent({
          menu: ctx.menu,
          agents: runtime.agents,
          current,
          t,
        })
      : undefined);

  if (chosen === undefined) {
    renderer.note(agentListing(runtime.agents, current, t));
    return CONTINUE;
  }
  if (!runtime.agents.some((agent) => agent.id === chosen)) {
    throw new GhostError(
      'not_found',
      t('slash.errors.noAgent', { id: chosen }),
    );
  }

  ctx.setAgent(chosen);

  // A conversation that exists moves; one nobody has spoken in has no row to
  // move, and the choice is only what the next one will run on.
  //
  // The `getSession` guard is load-bearing for the reason `/workspace` gives
  // below: `updateSession` calls `ensureSession` internally, so patching an
  // unspoken session would mint an empty row for it — which is what makes it
  // show up in the sidebar.
  if (runtime.store.getSession(ctx.sessionKey) === undefined) {
    renderer.note(t('slash.notes.willRunOn', { agent: chosen }));
    return CONTINUE;
  }
  runtime.store.updateSession(ctx.sessionKey, { agentId: chosen });
  renderer.note(t('slash.notes.movedAgent', { agent: chosen }));
  return CONTINUE;
}

/**
 * `/model` — what this install can reach, and which of them the next turn uses.
 *
 * **It does not write `config.json`.** `GhostRuntime.reconfigure` and
 * `saveConfig` are deliberately separate operations — previewing a patch and
 * committing one are different things — and a model chosen at a prompt is the
 * former: it lasts as long as the process. The settings panel is where a choice
 * is made permanent, and saying so is cheaper than a `/model --save` nobody
 * asked for.
 *
 * **It refuses outright under `--model`.** That flag is documented as a
 * statement about this process that the config cannot move, so a `/model` that
 * appeared to work and changed nothing would be worse than one that will not.
 */
async function modelCommand(
  id: string | undefined,
  ctx: SlashContext,
): Promise<SlashOutcome> {
  const { renderer, runtime, t } = ctx;
  if (ctx.modelPinned) {
    throw new GhostError('conflict', t('slash.errors.modelPinned'));
  }

  const chosen = id ?? (await chooseModel(ctx));
  if (chosen === undefined) return CONTINUE;

  runtime.reconfigure({ agents: { defaults: { model: chosen } } });
  renderer.note(t('slash.notes.modelSet', { model: chosen }));
  return CONTINUE;
}

/** The picker, or the listing, or a reason there is neither. */
async function chooseModel(ctx: SlashContext): Promise<string | undefined> {
  const { renderer, runtime, t } = ctx;
  const catalogue = await ctx.models.list();

  // Which endpoint went quiet, said out loud. A silently shorter list reads as
  // "that model is gone" rather than "that laptop is shut".
  for (const line of modelErrors(catalogue, t)) renderer.warn(line);

  if (catalogue.models.length === 0) {
    renderer.note(t('slash.notes.noModels'));
    return undefined;
  }

  if (!ctx.menu.available) {
    renderer.note(modelListing(catalogue, runtime.model));
    return undefined;
  }

  return await pickModel({
    menu: ctx.menu,
    catalogue,
    current: runtime.model,
    t,
  });
}

/**
 * `/memory`, and its two verbs.
 *
 * The switch is the `memory` tool's permission, not a setting of its own — see
 * `docs/memory.md`. That is why `on`/`off` reconfigure rather than writing to
 * the session row: the capability belongs to the agent, and a session-scoped
 * override would be a second source of truth for one question.
 *
 * There was a third, `compress`, which folded the oldest messages of a session
 * into a dated heading in the one `memory.md`. It went with the format: there is
 * no single accumulating file to compact, and a summary of a conversation is not
 * a fact about a workspace.
 */
async function memoryCommand(
  argv: readonly string[],
  ctx: SlashContext,
): Promise<SlashOutcome> {
  const [verb] = argv;

  switch (verb) {
    case undefined:
      return await memoryStatus(ctx);

    case 'on':
    case 'off':
      return setMemoryPermission(verb === 'on', ctx);

    default:
      throw new GhostError('invalid_input', ctx.t('slash.errors.usageMemory'));
  }
}

/** Which agent this conversation runs on, whether or not it has spoken yet. */
function memoryAgentId(ctx: SlashContext): string {
  const session = ctx.runtime.store.getSession(ctx.sessionKey);
  return session?.agentId ?? ctx.agentId ?? DEFAULT_AGENT_ID;
}

/** Whether that agent may call `memory`. Absent counts as denied. */
function memoryGranted(ctx: SlashContext, agentId: string): boolean {
  const permission = ctx.runtime.agents.find((agent) => agent.id === agentId)
    ?.tools.memory;
  return permission !== undefined && permission !== 'deny';
}

async function memoryStatus(ctx: SlashContext): Promise<SlashOutcome> {
  const { renderer, runtime, t } = ctx;
  const agentId = memoryAgentId(ctx);

  if (!memoryGranted(ctx, agentId)) {
    renderer.note(t('slash.notes.memoryOff', { agent: agentId }));
    return CONTINUE;
  }

  const memories = await readMemories(
    runtime.jails.forWorkspace(
      runtime.store.getSession(ctx.sessionKey)?.workspaceId ??
        DEFAULT_WORKSPACE_ID,
    ).root,
  );

  // A count and what the index costs, which are the two numbers an operator can
  // act on. The line this replaced measured one file, and there is no one file.
  renderer.note(
    memories.length === 0
      ? t('slash.notes.memoryEmpty', { path: MEMORY_DIRNAME })
      : t('slash.notes.memoryCount', {
          count: memories.length,
          path: MEMORY_DIRNAME,
          tokens: formatNumber(
            estimateTokens(memories.map((m) => m.description).join('\n')),
            ctx.locale,
          ),
        }),
  );

  return CONTINUE;
}

/**
 * Flips the `memory` permission on this conversation's agent.
 *
 * **The whole entry is rewritten, not patched.** `agents.list.*` is in
 * `REPLACE_WHOLESALE`, so sending `{tools: {memory: 'deny'}}` would delete every
 * other permission and every other override this agent holds. The effective map
 * is read back first and written whole.
 */
function setMemoryPermission(on: boolean, ctx: SlashContext): SlashOutcome {
  const { renderer, runtime, t } = ctx;
  const agentId = memoryAgentId(ctx);
  const agent = runtime.agents.find((entry) => entry.id === agentId);
  if (agent === undefined) {
    throw new GhostError('not_found', t('slash.errors.noAgent'));
  }

  const entry = runtime.config.agents.list[agentId] ?? {};
  runtime.reconfigure({
    agents: {
      list: {
        [agentId]: {
          ...entry,
          tools: { ...agent.tools, memory: on ? 'allow' : 'deny' },
        },
      },
    },
  });

  renderer.note(
    on
      ? t('slash.notes.memoryEnabled', { agent: agentId })
      : t('slash.notes.memoryDisabled', { agent: agentId }),
  );
  return CONTINUE;
}

async function workspaceCommand(
  argv: readonly string[],
  ctx: SlashContext,
): Promise<SlashOutcome> {
  const { renderer, runtime, t } = ctx;
  const [verb, ...rest] = argv;

  switch (verb) {
    case undefined: {
      const pending = ctx.workspaceId ?? 'default';
      // A picker on a terminal, the note everywhere else. No test types a bare
      // `/workspace`, so the scripted behaviour is unchanged by construction.
      if (ctx.menu.available) {
        const chosen = await pickWorkspace({
          menu: ctx.menu,
          workspaces: runtime.workspaces.list(),
          current: pending,
          t,
        });
        if (chosen !== undefined) return switchWorkspace(chosen, ctx);
      }
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

    default:
      // Not a verb, so it is an id: `/workspace <id>` switches.
      return switchWorkspace(verb, ctx);
  }
}

/** `/workspace <id>`, and what the picker resolves to. */
function switchWorkspace(id: string, ctx: SlashContext): SlashOutcome {
  const { renderer, runtime, t } = ctx;
  if (runtime.workspaces.get(id) === undefined) {
    throw new GhostError('not_found', t('slash.errors.noWorkspace', { id }));
  }
  ctx.setWorkspace(id);

  // A conversation that exists moves with the switch; one nobody has spoken in
  // has no row to move, and the choice is only where it will land.
  //
  // The `getSession` guard is load-bearing: `updateSession` calls
  // `ensureSession` internally, so patching an unspoken session would mint an
  // empty row for it — which is what makes it show up in the sidebar.
  if (runtime.store.getSession(ctx.sessionKey) === undefined) {
    renderer.note(t('slash.notes.willLandIn', { workspace: id }));
    return CONTINUE;
  }
  runtime.store.updateSession(ctx.sessionKey, { workspaceId: id });
  renderer.note(t('slash.notes.movedSession', { workspace: id }));
  return CONTINUE;
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
