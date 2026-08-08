import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveGhostPaths,
  type GhostPaths,
  type Logger,
} from '@ghostbot/core';

import { TELEGRAM_TOKEN_ENV_VAR, resolveTelegramToken } from '#src/telegram.js';

/**
 * A logger that keeps its warnings.
 *
 * `fields` rather than `_fields`: this repo has no `argsIgnorePattern`, so an
 * unused parameter that cannot be deleted — because a used one follows it —
 * just gets an ordinary name.
 */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const nothing = (): void => undefined;
  const logger = {
    trace: nothing,
    debug: nothing,
    info: nothing,
    warn: (fields: unknown, message?: string) => {
      warnings.push(message ?? '');
    },
    error: nothing,
    fatal: nothing,
    child: () => logger,
  } as unknown as Logger;
  return { logger, warnings };
}

const roots: string[] = [];

function paths(withVault = false): GhostPaths {
  const root = mkdtempSync(join(tmpdir(), 'ghostai-tg-'));
  roots.push(root);
  const resolved = resolveGhostPaths({ root });
  // Only the file's *existence* is checked before the vault is opened, which is
  // the condition being asserted rather than the vault's contents.
  if (withVault) writeFileSync(resolved.vaultFile, '{}');
  return resolved;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveTelegramToken', () => {
  it('finds nothing on an install that never configured a bot', async () => {
    // The normal case, and the one that has to stay cheap: `ghost serve` comes
    // up unchanged for everybody who has never heard of this.
    expect(
      resolveTelegramToken({ paths: paths(), env: {}, settings: {} }),
    ).toBeUndefined();
  });

  it('reads the environment variable', () => {
    expect(
      resolveTelegramToken({
        paths: paths(),
        env: { [TELEGRAM_TOKEN_ENV_VAR]: 'from-env' },
        settings: {},
      }),
    ).toBe('from-env');
  });

  it('reads the config block last', () => {
    expect(
      resolveTelegramToken({
        paths: paths(),
        env: {},
        settings: { token: 'from-config' },
      }),
    ).toBe('from-config');
  });

  it('prefers the environment over the config file', () => {
    expect(
      resolveTelegramToken({
        paths: paths(),
        env: { [TELEGRAM_TOKEN_ENV_VAR]: 'from-env' },
        settings: { token: 'from-config' },
      }),
    ).toBe('from-env');
  });

  it('warns once when the token is plain text in config.json', () => {
    // Backups, dotfile repositories and screen shares all reach that file.
    const { logger, warnings } = recordingLogger();
    resolveTelegramToken({
      paths: paths(),
      env: {},
      settings: { token: 'from-config' },
      logger,
    });

    expect(warnings.join('\n')).toContain('credential vault');
  });

  it('does not warn about a token that came from somewhere safe', () => {
    const { logger, warnings } = recordingLogger();
    resolveTelegramToken({
      paths: paths(),
      env: { [TELEGRAM_TOKEN_ENV_VAR]: 'from-env' },
      settings: {},
      logger,
    });

    expect(warnings).toEqual([]);
  });

  it('ignores an empty string rather than treating it as a token', () => {
    expect(
      resolveTelegramToken({
        paths: paths(),
        env: { [TELEGRAM_TOKEN_ENV_VAR]: '' },
        settings: { token: '' },
      }),
    ).toBeUndefined();
  });

  it('does not open the vault when there is not one', () => {
    // `resolveVaultKey` writes a key to the OS keychain the first time it runs,
    // so an install that stores no credential must not acquire an entry just by
    // booting. Reaching the environment at all proves the vault was skipped.
    const resolved = paths();

    expect(
      resolveTelegramToken({
        paths: resolved,
        env: { [TELEGRAM_TOKEN_ENV_VAR]: 'from-env' },
        settings: {},
      }),
    ).toBe('from-env');
  });
});
