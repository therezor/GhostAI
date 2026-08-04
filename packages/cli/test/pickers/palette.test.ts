import { describe, expect, it } from 'vitest';

import { commandRows } from '#src/commands.js';
import { translations } from '#src/i18n.js';
import {
  commandItems,
  commandValue,
  completeCommand,
} from '#src/pickers/palette.js';

const { t } = translations('en');

describe('commandValue', () => {
  it('stops at the first placeholder, so what lands on the line is typeable', () => {
    expect(commandValue('/agent [id]')).toBe('/agent');
    expect(commandValue('/rename <title>')).toBe('/rename');
    expect(commandValue('/workspace move <from> <to>')).toBe('/workspace move');
  });

  it('keeps a command that takes nothing whole', () => {
    expect(commandValue('/help')).toBe('/help');
    expect(commandValue('/context')).toBe('/context');
  });

  it('takes the first of a pair of aliases, because they are the same command', () => {
    expect(commandValue('/exit, /quit')).toBe('/exit');
  });
});

describe('commandItems', () => {
  const items = commandItems(commandRows(), t);

  it('offers every command the help page lists', () => {
    expect(items).toHaveLength(commandRows().length);
    expect(items.map((item) => item.label)).toContain('/agent [id]');
  });

  it('shows the syntax, with its description beside it', () => {
    const help = items.find((item) => item.label === '/help');
    expect(help?.hint).toBe('this list');
  });

  it('submits a command that needs nothing, and only types one that does', () => {
    // `/rename` alone is a usage error the operator would have to read and then
    // retype around. Putting it in the editor and stopping is the better answer.
    const agent = items.find((item) => item.label === '/agent [id]');
    expect(agent?.value).toEqual({ command: '/agent', submit: true });

    const rename = items.find((item) => item.label === '/rename <title>');
    expect(rename?.value).toEqual({ command: '/rename', submit: false });
  });

  it('leaves a variant row without a description rather than inventing one', () => {
    const variant = items.find(
      (item) => item.label === '/workspace new <name>',
    );
    expect(variant?.hint).toBeUndefined();
  });
});

describe('completeCommand', () => {
  it('completes a slash command from the same table the help page uses', () => {
    const [hits, line] = completeCommand('/work');
    expect(line).toBe('/work');
    expect(hits).toContain('/workspaces');
    expect(hits).toContain('/workspace move');
  });

  it('offers nothing for prose, which is what a prompt is mostly made of', () => {
    expect(completeCommand('what is')).toEqual([[], 'what is']);
    expect(completeCommand('')).toEqual([[], '']);
  });

  it('offers each command once, however many rows describe it', () => {
    const [hits] = completeCommand('/');
    expect(new Set(hits).size).toBe(hits.length);
  });

  it('offers nothing for a command that does not exist', () => {
    const [hits] = completeCommand('/zzz');
    expect(hits).toEqual([]);
  });
});
