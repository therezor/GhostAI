/**
 * Tab completion for a `@skill:` mention.
 *
 * The cases that matter are the ones where a naive completer says yes and should
 * not. `chat.ts` argues that Tab completes "only a slash command" because a
 * completer guessing at the middle of a sentence surprises more than it helps;
 * these are the assertions that keep the mention from becoming that guess.
 */

import { describe, expect, it } from 'vitest';

import type { Skill } from '@ghostai/agent';

import {
  applySkill,
  completeSkill,
  mentionPrefix,
  skillItems,
} from '#src/pickers/skills.js';

function make(name: string): Skill {
  return {
    name,
    description: `What ${name} does.`,
    body: `Body of ${name}.`,
    path: `skills/${name}/SKILL.md`,
  };
}

const SKILLS = [make('code-review'), make('deploy'), make('deploy-notes')];

describe('mentionPrefix', () => {
  it('finds a name being typed', () => {
    expect(mentionPrefix('look at @skill:dep')).toBe('dep');
  });

  it('is an empty string when the prefix is complete and nothing follows', () => {
    // Distinct from `undefined`: this should offer the whole catalogue rather
    // than nothing.
    expect(mentionPrefix('@skill:')).toBe('');
  });

  it('is nothing when the line holds no mention', () => {
    expect(mentionPrefix('just a sentence')).toBeUndefined();
    expect(mentionPrefix('')).toBeUndefined();
  });

  it('is nothing once the mention is finished', () => {
    // Whitespace ends a bare name in the protocol's own pattern, so a completed
    // mention with prose after it is not the thing being typed. Completing it
    // would rewrite text behind the cursor.
    expect(mentionPrefix('@skill:deploy and then ship')).toBeUndefined();
  });

  it('reads the last mention, not the first', () => {
    expect(mentionPrefix('@skill:deploy then @skill:cod')).toBe('cod');
  });
});

describe('completeSkill', () => {
  it('offers the names that extend what is typed', () => {
    expect(completeSkill('@skill:dep', SKILLS)).toEqual([
      'deploy',
      'deploy-notes',
    ]);
  });

  it('offers the whole catalogue for a bare prefix', () => {
    expect(completeSkill('@skill:', SKILLS)).toHaveLength(3);
  });

  it('offers nothing outside a mention', () => {
    // The rule the file exists to keep: Tab in prose does nothing at all.
    expect(completeSkill('deploy the thing', SKILLS)).toEqual([]);
  });

  it('offers nothing for a name that matches none', () => {
    expect(completeSkill('@skill:zzz', SKILLS)).toEqual([]);
  });
});

describe('applySkill', () => {
  it('completes the name and closes the mention with a space', () => {
    expect(applySkill('look at @skill:dep', 'deploy')).toBe(
      'look at @skill:deploy ',
    );
  });

  it('leaves everything before the mention alone', () => {
    expect(applySkill('@skill:deploy then @skill:cod', 'code-review')).toBe(
      '@skill:deploy then @skill:code-review ',
    );
  });

  it('is the identity on a line with no mention', () => {
    expect(applySkill('nothing here', 'deploy')).toBe('nothing here');
  });
});

describe('skillItems', () => {
  it('labels a row with the mention it inserts, and hints the description', () => {
    // The label is the thing to type rather than the bare name, because the
    // point of the picker is teaching that `@skill:` is how a sheet is sent.
    expect(skillItems([make('deploy')])).toEqual([
      {
        value: 'deploy',
        label: '@skill:deploy',
        hint: 'What deploy does.',
      },
    ]);
  });
});
