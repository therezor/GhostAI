import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { DEFAULT_AGENT_ID, RESERVED_AGENT_IDS, deriveAgentId, isAgentId } from '#src/agent-id.js';
import { isWorkspaceId } from '#src/workspace-id.js';

describe('agent ids', () => {
  it.each([
    ['a single character', 'a'],
    ['digits', '2024'],
    ['hyphens inside', 'code-reviewer'],
    ['the default', 'default'],
    ['forty characters', 'a'.repeat(40)],
  ])('accepts %s', (_name, id) => {
    expect(isAgentId(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a traversal', '..'],
    ['a separator', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a colon', 'c:'],
    ['a NUL byte', 'a\0b'],
    ['a home prefix', '~agent'],
    ['a leading hyphen', '-agent'],
    ['a trailing hyphen', 'agent-'],
    ['uppercase', 'Reviewer'],
    ['a space', 'my agent'],
    ['forty-one characters', 'a'.repeat(41)],
  ])('refuses %s', (_name, id) => {
    expect(isAgentId(id)).toBe(false);
  });

  it('refuses uppercase because case-folding filesystems would share one directory', () => {
    // Two agents believing their memory is separate, over one directory.
    expect(isAgentId('Reviewer')).toBe(false);
    expect(deriveAgentId('Reviewer')).toBe('reviewer');
  });

  it.each([
    ['Code Reviewer', 'code-reviewer'],
    ['  Spaced  out  ', 'spaced-out'],
    ['Ünïcödé', 'n-c-d'],
    ['///', 'agent'],
    ['', 'agent'],
    ['default', 'agent'],
    ['CON', 'agent'],
  ])('derives %j to %j', (label, expected) => {
    expect(deriveAgentId(label)).toBe(expected);
  });

  it('always derives something legal, for any label at all', () => {
    fc.assert(
      fc.property(fc.string(), (label) => {
        const id = deriveAgentId(label);
        expect(isAgentId(id)).toBe(true);
        expect(RESERVED_AGENT_IDS.has(id)).toBe(false);
      }),
      { numRuns: 1000 },
    );
  });

  it('reserves the default as a name to create but not as one to resolve', () => {
    // `agents.list.default` is legal to write — it customises the agent an
    // install already runs as. What is refused is minting a *second* agent
    // under that name from a label.
    expect(isAgentId(DEFAULT_AGENT_ID)).toBe(true);
    expect(RESERVED_AGENT_IDS.has(DEFAULT_AGENT_ID)).toBe(true);
    expect(deriveAgentId('Default')).toBe('agent');
  });

  it('shares one rule set with workspace ids', () => {
    // The two are separate modules so their reservations can differ, but the
    // character rules must not drift — both become directory names.
    fc.assert(
      fc.property(fc.string(), (value) => {
        expect(isAgentId(value)).toBe(isWorkspaceId(value));
      }),
      { numRuns: 500 },
    );
  });
});
