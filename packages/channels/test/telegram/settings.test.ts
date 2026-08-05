import { describe, expect, it } from 'vitest';

import { parseTelegramSettings } from '#src/telegram/settings.js';

describe('parseTelegramSettings', () => {
  it('fills in every default from an empty block', () => {
    const settings = parseTelegramSettings({});

    expect(settings).toEqual({
      enabled: true,
      allowlist: [],
      admins: [],
      pollTimeoutSec: 30,
      editIntervalMs: 2000,
      apiBase: 'https://api.telegram.org',
    });
  });

  it('reads the block the config schema already accepts', () => {
    // `packages/protocol/test/config.test.ts` asserts this exact shape parses.
    const settings = parseTelegramSettings({ allowlist: ['1|me'] });

    expect(settings.allowlist).toEqual(['1|me']);
  });

  it('carries the agent and workspace a conversation is born into', () => {
    const settings = parseTelegramSettings({
      agentId: 'researcher',
      workspaceId: 'notes',
    });

    expect(settings.agentId).toBe('researcher');
    expect(settings.workspaceId).toBe('notes');
  });

  it('refuses a poll timeout Telegram would not honour', () => {
    // Telegram caps a long poll at 50 seconds.
    expect(() => parseTelegramSettings({ pollTimeoutSec: 120 })).toThrow(
      /pollTimeoutSec/u,
    );
  });

  it('refuses a misspelled type rather than falling back to a default', () => {
    // A channel that ignored this would come up answering nobody, and nothing
    // would say why.
    expect(() => parseTelegramSettings({ allowlist: '1|me' })).toThrow(
      /channels\.telegram is not usable/u,
    );
  });

  it('names the path that is wrong', () => {
    expect(() => parseTelegramSettings({ enabled: 'yes' })).toThrow(/enabled/u);
  });

  it('leaves an unknown key alone, so a newer build’s setting is not a fault', () => {
    expect(() => parseTelegramSettings({ somethingNewer: 1 })).not.toThrow();
  });
});
