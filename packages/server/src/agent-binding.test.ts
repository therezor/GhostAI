import { describe, expect, it } from 'vitest';

import { agentForTurn } from './agent-binding.js';

/** Everything but `deleted` resolves. */
const resolves = (agentId: string): boolean => agentId !== 'deleted';

describe('agentForTurn', () => {
  it('takes the frame’s pick for a session that does not exist yet', () => {
    expect(agentForTurn({ stored: undefined, requested: 'reviewer', resolves })).toBe('reviewer');
    expect(agentForTurn({ stored: '', requested: 'reviewer', resolves })).toBe('reviewer');
  });

  it('leaves an unbound session unbound when the frame names nobody', () => {
    expect(agentForTurn({ stored: undefined, requested: undefined, resolves })).toBeUndefined();
  });

  it('keeps the stored agent even when the frame names another', () => {
    // The rule this exists for. A history built under one agent's prompt, tools
    // and permissions must not silently continue under another's — moving a
    // session is an explicit PATCH, never a side effect of a frame.
    expect(agentForTurn({ stored: 'writer', requested: 'reviewer', resolves })).toBe('writer');
  });

  it('lets the frame win when the stored agent no longer resolves', () => {
    // The one exception. A deleted agent offers no settings to protect, so
    // outranking the operator's explicit pick would only drop them onto the
    // default while they watched themselves choose something else.
    expect(agentForTurn({ stored: 'deleted', requested: 'reviewer', resolves })).toBe('reviewer');
  });

  it('keeps the stored agent when neither resolves', () => {
    // So the notice that follows names what the conversation actually claims
    // rather than whatever the last frame happened to carry.
    expect(agentForTurn({ stored: 'deleted', requested: 'deleted', resolves })).toBe('deleted');
    expect(agentForTurn({ stored: 'deleted', requested: undefined, resolves })).toBe('deleted');
  });
});
