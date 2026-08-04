import type { SessionSummaryRecord, WorkspaceRecord } from '@ghostai/core';
import { describe, expect, it } from 'vitest';

import { translations } from '#src/i18n.js';
import { sessionItems } from '#src/pickers/sessions.js';
import { workspaceItems } from '#src/pickers/workspaces.js';

const { t } = translations('en');

/** Only the fields the row builder reads; a record carries a dozen more. */
function session(
  key: string,
  title: string,
  messageCount: number,
): SessionSummaryRecord {
  return { key, title, messageCount } as unknown as SessionSummaryRecord;
}

function workspace(id: string, name: string): WorkspaceRecord {
  return { id, name } as unknown as WorkspaceRecord;
}

describe('sessionItems', () => {
  const rows = [
    session('cli-9f2ab1', 'Refactor the parser', 12),
    session('cli-0000aa', '', 1),
  ];

  it('shows the title, because that is what a person recognises', () => {
    expect(sessionItems(rows, 'cli-9f2ab1', t)[0]?.label).toBe(
      'Refactor the parser',
    );
  });

  it('falls back to the key for a session nobody has named', () => {
    expect(sessionItems(rows, 'cli-9f2ab1', t)[1]?.label).toBe('cli-0000aa');
  });

  it('counts the messages, and gets the singular right', () => {
    const items = sessionItems(rows, 'nothing', t);
    expect(items[0]?.hint).toBe('12 messages');
    expect(items[1]?.hint).toBe('1 message');
  });

  it('marks the one the prompt is on', () => {
    expect(sessionItems(rows, 'cli-9f2ab1', t)[0]?.hint).toContain('current');
  });

  it('keeps the key searchable, for when two conversations share a name', () => {
    expect(sessionItems(rows, 'nothing', t)[0]?.keywords).toBe('cli-9f2ab1');
  });

  it('makes no rows for no sessions', () => {
    expect(sessionItems([], 'nothing', t)).toEqual([]);
  });
});

describe('workspaceItems', () => {
  const rows = [
    workspace('default', 'Default'),
    workspace('research', 'Research'),
  ];

  it('shows the name, with the id beside it', () => {
    // The id and not a session count: a workspace is where a conversation
    // *starts*, and one can be moved to another afterwards, so a count there
    // implies an ownership that does not hold. The id is what `/workspace <id>`
    // takes, which makes it the useful thing to show.
    const items = workspaceItems(rows, undefined, t);
    expect(items[0]?.label).toBe('Default');
    expect(items[0]?.hint).toBe('default');
    expect(items[1]?.hint).toBe('research');
  });

  it('says nothing about how many sessions are in one', () => {
    for (const item of workspaceItems(rows, undefined, t)) {
      expect(item.hint).not.toMatch(/session/u);
    }
  });

  it('marks the one new sessions land in', () => {
    const items = workspaceItems(rows, 'research', t);
    expect(items[1]?.hint).toContain('current');
    expect(items[0]?.hint).not.toContain('current');
  });

  it('makes no rows for no workspaces', () => {
    expect(workspaceItems([], undefined, t)).toEqual([]);
  });
});
