import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { helpText, runSlashCommand, type SlashContext } from '#src/commands.js';
import { translations } from '#src/i18n.js';
import { TurnRenderer } from '#src/render.js';
import { createChatRuntime, type ChatRuntime } from '#src/runtime.js';

const { t } = translations('en');
const help = helpText(t);
const lines = help.split('\n').filter((line) => line.trim().startsWith('/'));

describe('helpText', () => {
  it('lists every command a reader can type', () => {
    expect(help).toContain('/messages [n]');
    expect(help).toContain('/workspace move <from> <to>');
    expect(help).toContain('the last n messages, with their seq numbers');
  });

  it('groups the commands under headings', () => {
    for (const heading of [
      'sessions',
      'messages',
      'context and cost',
      'workspaces',
    ]) {
      expect(help).toContain(`\n  ${heading}\n`);
    }
  });

  it('aligns every description in one column', () => {
    // The bug this replaces: the column was a fixed number of spaces typed in
    // by hand, so it held only while every description was English — and the
    // first row was two characters out even then.
    const described = lines.filter((line) =>
      / {2,}\S/u.test(line.trimStart().slice(1)),
    );
    const columns = new Set(
      described.map((line) => line.search(/\S(?!.*\s\s)/u)),
    );

    expect(described.length).toBeGreaterThan(15);
    expect(columns.size).toBe(1);
  });

  it('indents every row the same, including the first', () => {
    expect(lines.every((line) => line.startsWith('  /'))).toBe(true);
  });

  it('renders the same syntax whatever the locale', () => {
    // `/rename` is what a user types, not a word describing it, so the left
    // column must survive translation untouched. Asserted against a locale that
    // does not exist, which falls back to English for the *descriptions* while
    // proving the syntax never went through `t` at all.
    const other = helpText(translations('zz').t);

    expect(other).toContain('/rename <title>');
    expect(other).toContain('/workspace move <from> <to>');
  });
});

describe('/workspace <id>', () => {
  const homes: string[] = [];

  function runtimeIn(): ChatRuntime {
    const home = mkdtempSync(join(tmpdir(), 'ghostai-slash-'));
    homes.push(home);
    mkdirSync(join(home, 'workspace'), { recursive: true });
    return createChatRuntime({ home });
  }

  afterEach(() => {
    while (homes.length > 0) {
      const dir = homes.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  function context(
    runtime: ChatRuntime,
    sessionKey: string,
  ): {
    readonly ctx: SlashContext;
    readonly chosen: string[];
    readonly out: { text: string };
  } {
    const chosen: string[] = [];
    const out = {
      text: '',
      write(chunk: string): boolean {
        out.text += chunk;
        return true;
      },
    };
    return {
      chosen,
      out,
      ctx: {
        renderer: new TurnRenderer({ out }),
        runtime,
        t,
        locale: 'en',
        sessionKey,
        workspaceId: undefined,
        setWorkspace: (id) => chosen.push(id ?? 'default'),
      },
    };
  }

  it('moves a conversation that exists', async () => {
    const runtime = runtimeIn();
    runtime.workspaces.create({ name: 'Research', id: 'research' });
    runtime.store.ensureSession('cli:1');

    const { ctx, chosen } = context(runtime, 'cli:1');
    await runSlashCommand('/workspace research', ctx);

    expect(chosen).toEqual(['research']);
    expect(runtime.store.getSession('cli:1')?.workspaceId).toBe('research');
  });

  it('does not mint a row for a session nobody has spoken in', async () => {
    // `updateSession` calls `ensureSession` internally, so patching an unspoken
    // conversation would create it — and an empty session would then show up in
    // every listing as though it were real.
    const runtime = runtimeIn();
    runtime.workspaces.create({ name: 'Research', id: 'research' });

    const { ctx, chosen } = context(runtime, 'cli:unspoken');
    await runSlashCommand('/workspace research', ctx);

    expect(chosen).toEqual(['research']);
    expect(runtime.store.getSession('cli:unspoken')).toBeUndefined();
  });

  it('refuses a workspace that does not exist, without moving anything', async () => {
    // Warned rather than thrown: a mistyped command must not end the REPL.
    const runtime = runtimeIn();
    runtime.store.ensureSession('cli:1');
    const { ctx, chosen, out } = context(runtime, 'cli:1');

    await runSlashCommand('/workspace nope', ctx);

    expect(out.text).toContain('nope');
    expect(chosen).toEqual([]);
    expect(runtime.store.getSession('cli:1')?.workspaceId).toBe('default');
  });
});
