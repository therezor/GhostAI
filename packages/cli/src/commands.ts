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

import { randomUUID } from 'node:crypto';

import { describeContext, type ContextReport } from '@ghostai/agent';
import { GhostError, isGhostError, textOf, type SessionStore } from '@ghostai/core';
import type { ContentPart } from '@ghostai/protocol';

import { recentMessages, resolveSeq, DEFAULT_MESSAGE_LINES } from './messages.js';
import type { TurnRenderer } from './render.js';
import type { ChatRuntime } from './runtime.js';

/** What a slash command asks the REPL to do next. */
export type SlashOutcome =
  | { readonly kind: 'continue' }
  | { readonly kind: 'exit' }
  /** Attach the prompt to another conversation. */
  | { readonly kind: 'attach'; readonly sessionKey: string }
  /** Run this content as a turn, through the REPL's own path. */
  | { readonly kind: 'turn'; readonly content: string | readonly ContentPart[] };

const CONTINUE: SlashOutcome = { kind: 'continue' };

export interface SlashContext {
  readonly renderer: TurnRenderer;
  readonly runtime: ChatRuntime;
  /** Read at call time: the REPL's attachment moves. */
  readonly sessionKey: string;
  /** Where a *new* conversation lands. `undefined` means the default. */
  readonly workspaceId: string | undefined;
  readonly setWorkspace: (id: string | undefined) => void;
}

export const HELP = `/help                       this list
  /messages [n]               the last n messages, with their seq numbers
  /clear                      forget this session's history
  /exit, /quit                leave

  sessions
  /sessions [n]               conversations in this workspace, newest first
  /new [title]                start a fresh conversation and attach to it
  /session [key]              show this session, or attach to another
  /rename <title>             rename this conversation
  /delete [key]               delete one, defaulting to this one
  /branch [ref]               fork up to <ref> and attach to the fork

  messages
  /edit <ref> <text>          replace a message and re-run from there
  /regenerate [ref]           re-run the last turn, or the one <ref> started

  context and cost
  /context                    what the next turn would send to the model
  /stats [n]                  the last n turns: model, tokens, tokens/s, time

  workspaces
  /workspaces                 list them, marking the current one
  /workspace <id>             show or switch where new conversations land
  /workspace new <name>
  /workspace rename <id> <name>
  /workspace rm <id>          detach; refuses while conversations name it
  /workspace move <from> <to> move conversations between workspaces

  A <ref> is a seq number from /messages, or a negative offset over your own
  messages: -1 is the last thing you said. It defaults to -1.`;

/**
 * Runs one slash command.
 *
 * Never throws for anything a user typed: a `GhostError` from a primitive is
 * rendered as a warning and the prompt comes back. A REPL that exits on a
 * mistyped session key would be worse than the mistyped key.
 */
export async function runSlashCommand(input: string, ctx: SlashContext): Promise<SlashOutcome> {
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
  const { renderer, runtime } = ctx;
  const store = runtime.store;

  switch (name) {
    case 'exit':
    case 'quit':
      return { kind: 'exit' };

    case 'help':
      renderer.note(HELP);
      return CONTINUE;

    case 'clear':
      store.clearMessages(ctx.sessionKey);
      renderer.note('history cleared');
      return CONTINUE;

    case 'messages': {
      const count = positiveCount(argv[0]) ?? DEFAULT_MESSAGE_LINES;
      const rows = recentMessages(store, ctx.sessionKey, count);
      if (rows.length === 0) {
        renderer.note('nothing said in this conversation yet');
        return CONTINUE;
      }
      renderer.note(
        rows.map((row) => `${pad(row.seq)}  ${row.role}  ${clip(row.text)}`).join('\n'),
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
        renderer.note('no conversations yet');
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
        ...(ctx.workspaceId === undefined ? {} : { workspaceId: ctx.workspaceId }),
      });
      return { kind: 'attach', sessionKey: key };
    }

    case 'session': {
      const target = argv[0];
      if (target === undefined) {
        const session = store.getSession(ctx.sessionKey);
        const title = session === undefined || session.title === '' ? '(unnamed)' : session.title;
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
      if (tail === '') throw new GhostError('invalid_input', 'usage: /rename <title>');
      store.updateSession(ctx.sessionKey, { title: tail });
      renderer.note(`renamed to ${tail}`);
      return CONTINUE;
    }

    case 'delete': {
      const key = argv[0] ?? ctx.sessionKey;
      if (!store.deleteSession(key)) {
        throw new GhostError('not_found', `No conversation ${key}`);
      }
      renderer.note(`deleted ${key}`);
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
        throw new GhostError('invalid_input', 'usage: /edit <ref> <text>');
      }
      const seq = requireUserMessage(store, ctx.sessionKey, resolveSeq(store, ctx.sessionKey, ref));
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
      );
      const [record] = store.messages(ctx.sessionKey, { afterSeq: seq - 1, beforeSeq: seq + 1 });
      if (record === undefined) throw new GhostError('not_found', 'That message is gone');
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
        renderer.note('nothing to measure yet — this conversation has not started');
        return CONTINUE;
      }
      renderer.note(formatContext(report));
      return CONTINUE;
    }

    case 'stats': {
      const limit = positiveCount(argv[0]) ?? 10;
      const rows = store.turnStats(ctx.sessionKey, { limit });
      if (rows.length === 0) {
        renderer.note('no turns recorded for this conversation yet');
        return CONTINUE;
      }
      renderer.stats(rows);
      return CONTINUE;
    }

    // ── Workspaces ────────────────────────────────────────────

    case 'workspaces': {
      const current = ctx.workspaceId ?? store.getSession(ctx.sessionKey)?.workspaceId;
      renderer.note(
        runtime.workspaces
          .list()
          .map((workspace) => {
            const mark = workspace.id === current ? '*' : ' ';
            const count = store.countByWorkspace(workspace.id);
            return `${mark} ${workspace.id}  ·  ${workspace.name}  ·  ${String(count)} conversations`;
          })
          .join('\n'),
      );
      return CONTINUE;
    }

    case 'workspace':
      return workspaceCommand(argv, ctx);

    default:
      renderer.warn(`unknown command: /${name}`);
      return CONTINUE;
  }
}

function workspaceCommand(argv: readonly string[], ctx: SlashContext): SlashOutcome {
  const { renderer, runtime } = ctx;
  const [verb, ...rest] = argv;

  switch (verb) {
    case undefined: {
      const pending = ctx.workspaceId ?? 'default';
      renderer.note(`new conversations land in ${pending}`);
      return CONTINUE;
    }

    case 'new': {
      const name = rest.join(' ').trim();
      if (name === '') throw new GhostError('invalid_input', 'usage: /workspace new <name>');
      const created = runtime.workspaces.create({ name });
      renderer.note(`created ${created.id}`);
      return CONTINUE;
    }

    case 'rename': {
      const [id, ...words] = rest;
      const name = words.join(' ').trim();
      if (id === undefined || name === '') {
        throw new GhostError('invalid_input', 'usage: /workspace rename <id> <name>');
      }
      runtime.workspaces.rename(id, name);
      renderer.note(`renamed ${id} to ${name}`);
      return CONTINUE;
    }

    case 'rm': {
      const id = rest[0];
      if (id === undefined) throw new GhostError('invalid_input', 'usage: /workspace rm <id>');
      // The same refusal the web manager makes, and for the same reason: a
      // detached workspace whose conversations still name it would leave them
      // resolving to files nothing lists. Two explicit steps, not one silent one.
      const count = runtime.store.countByWorkspace(id);
      if (count > 0) {
        throw new GhostError(
          'conflict',
          `${String(count)} conversations are still in ${id}. Move them first: /workspace move ${id} default`,
        );
      }
      runtime.workspaces.delete(id);
      renderer.note(`detached ${id}`);
      if (ctx.workspaceId === id) ctx.setWorkspace(undefined);
      return CONTINUE;
    }

    case 'move': {
      const [from, to] = rest;
      if (from === undefined || to === undefined) {
        throw new GhostError('invalid_input', 'usage: /workspace move <from> <to>');
      }
      if (runtime.workspaces.get(to) === undefined) {
        throw new GhostError('not_found', `No workspace ${to}`);
      }
      const moved = runtime.store.reassignWorkspace(from, to);
      renderer.note(`moved ${String(moved)} conversations from ${from} to ${to}`);
      return CONTINUE;
    }

    default: {
      // Not a verb, so it is an id: `/workspace <id>` switches.
      if (runtime.workspaces.get(verb) === undefined) {
        throw new GhostError('not_found', `No workspace ${verb}`);
      }
      ctx.setWorkspace(verb);
      // Worth stating rather than leaving to be discovered: a session's
      // workspace is fixed at birth, so this moves nothing that exists.
      renderer.note(`new conversations will land in ${verb}`);
      return CONTINUE;
    }
  }
}

/** Only a message the user wrote can be edited or re-run. */
function requireUserMessage(store: SessionStore, sessionKey: string, seq: number): number {
  const [record] = store.messages(sessionKey, { afterSeq: seq - 1, beforeSeq: seq + 1 });
  if (record?.message.role !== 'user') {
    throw new GhostError('invalid_input', `Message ${String(seq)} is not one of yours`);
  }
  return seq;
}

function formatContext(report: ContextReport): string {
  const percent = Math.round((report.estimatedTokens / report.contextWindowTokens) * 100);
  // Named rather than iterated: the three sections are a fixed set with a
  // meaningful order, and `Object.entries` would print them in whatever order
  // the object happens to hold while typing each value as `any`.
  const { systemPrompt, tools, messages } = report.breakdown;
  return [
    `${report.estimatedTokens.toLocaleString()} of ${report.contextWindowTokens.toLocaleString()} tokens · ${String(percent)}%`,
    `  ${'system'.padEnd(10)}${systemPrompt.toLocaleString()}`,
    `  ${'tools'.padEnd(10)}${tools.toLocaleString()}`,
    `  ${'messages'.padEnd(10)}${messages.toLocaleString()}`,
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
  return randomUUID();
}
