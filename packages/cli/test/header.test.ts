import { PLAIN_THEME, visibleWidth } from '@ghostwire/tui';
import { describe, expect, it } from 'vitest';

import {
  contextLabel,
  startupHeader,
  statusBar,
  type HeaderView,
} from '#src/header.js';
import { translations } from '#src/i18n.js';

const { t } = translations('en');

const VIEW: HeaderView = {
  agent: 'Reviewer',
  model: 'claude-opus-5',
  provider: 'Anthropic',
  workspace: '/home/dev/workspace',
  workspaceName: 'Research',
  session: 'a conversation',
  context: { usedTokens: 15_872, windowTokens: 128_000 },
};

describe('startupHeader', () => {
  it('names every field the operator needs to know they are in the right place', () => {
    const header = startupHeader(VIEW, 80, PLAIN_THEME, t, false);
    for (const value of [
      VIEW.agent,
      VIEW.model,
      VIEW.provider,
      VIEW.workspace,
      VIEW.session,
    ]) {
      expect(header).toContain(value);
    }
  });

  it('aligns the values in one column, measured rather than counted', () => {
    // A run of hand-counted spaces holds only until the first translation is
    // longer than the English it replaced, and then it is wrong for every row.
    const rows = startupHeader(VIEW, 80, PLAIN_THEME, t, false)
      .split('\n')
      .filter(
        (line) => line.includes('claude-opus-5') || line.includes('Anthropic'),
      );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.indexOf('claude-opus-5')).toBe(
      rows[1]?.indexOf('Anthropic'),
    );
  });

  it('mentions the menu only when there is a terminal that can draw one', () => {
    expect(startupHeader(VIEW, 80, PLAIN_THEME, t, true)).toContain('ctrl-g');
    expect(startupHeader(VIEW, 80, PLAIN_THEME, t, false)).not.toContain(
      'ctrl-g',
    );
  });

  it('never writes a line wider than the window', () => {
    for (const width of [20, 40, 80]) {
      for (const line of startupHeader(VIEW, width, PLAIN_THEME, t, true).split(
        '\n',
      )) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe('contextLabel', () => {
  it('says how full the window is, and how big it is', () => {
    expect(contextLabel({ usedTokens: 15_872, windowTokens: 128_000 })).toBe(
      '12.4%/128k',
    );
  });

  it('says nothing before a turn has been measured', () => {
    expect(contextLabel(undefined)).toBe('');
  });

  it('says nothing rather than dividing by a window of nothing', () => {
    expect(contextLabel({ usedTokens: 10, windowTokens: 0 })).toBe('');
  });
});

describe('statusBar', () => {
  it('opens with a rule the width it was given', () => {
    // The whole frame is here rather than half of it in the prompt: a prompt
    // string is written into the scrollback, so a rule drawn there outlives the
    // turn and becomes a separator between messages.
    const [first] = statusBar(VIEW, 40, PLAIN_THEME);
    expect(visibleWidth(first ?? '')).toBe(40);
    expect(first).toMatch(/^─+$/u);
  });

  it('puts the workspace and the agent on one row, at opposite ends', () => {
    const [, row] = statusBar(VIEW, 40, PLAIN_THEME);
    expect(row?.startsWith('Research')).toBe(true);
    expect(row?.endsWith('Reviewer')).toBe(true);
  });

  it('puts the context budget and the model on the next one', () => {
    const [, , row] = statusBar(VIEW, 44, PLAIN_THEME);
    expect(row?.startsWith('12.4%/128k')).toBe(true);
    expect(row?.endsWith('Anthropic/claude-opus-5')).toBe(true);
  });

  it('names the model alone when there is no provider to name', () => {
    const [, , row] = statusBar({ ...VIEW, provider: '' }, 44, PLAIN_THEME);
    expect(row?.endsWith('claude-opus-5')).toBe(true);
    expect(row).not.toContain('/claude');
  });

  it('leaves the context side blank before a turn has been measured', () => {
    const bar = statusBar({ ...VIEW, context: undefined }, 44, PLAIN_THEME);
    expect(bar[2]?.trimStart().startsWith('Anthropic')).toBe(true);
  });

  it('never writes a row wider than the window', () => {
    // A row that wraps takes two of the rows the bar reserved, and the one it
    // pushes off the bottom is the one the operator was reading.
    for (const width of [12, 24, 40, 100]) {
      for (const row of statusBar(VIEW, width, PLAIN_THEME)) {
        expect(visibleWidth(row)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('is three rows, which is what the caller has to reserve', () => {
    expect(statusBar(VIEW, 40, PLAIN_THEME)).toHaveLength(3);
  });
});
