/**
 * `channels.telegram`, parsed by the channel that reads it.
 *
 * `ChannelsConfigSchema` is a `looseObject` precisely so this can live here
 * rather than in `@ghostwire/protocol`: a channel owns its own block, and a bad
 * one is reported by refusing to start rather than by behaving oddly later.
 *
 * The bot token is deliberately **not** here. It is resolved by whoever builds
 * the factory, from the credential vault first — `ChannelContext` has no vault
 * and no environment by design, and a token is the one setting that should not
 * be sitting in a world-readable JSON file.
 */

import { z } from 'zod';

/**
 * Telegram's own ceiling on a long poll is 50 seconds, and undici gives up on
 * headers at 300. Thirty is long enough that the bot is not re-asking all day
 * and short enough that `stop()` is not waiting on it.
 */
const DEFAULT_POLL_TIMEOUT_SEC = 30;

/**
 * What a parsed block is, written out rather than inferred.
 *
 * `isolatedDeclarations` is on in this package — `@ghostwire/protocol` is the one
 * place it is off, precisely because a Zod schema export *is* an inference
 * result — so the schema below stays module-private and this is the shape the
 * rest of the channel sees. The two are kept in step by `parseTelegramSettings`
 * returning this type: a field the schema stops producing fails to compile at
 * the `return`, and the defaults are asserted whole in the test.
 */
export interface TelegramSettings {
  readonly enabled: boolean;
  readonly allowlist: readonly string[];
  readonly admins: readonly string[];
  readonly agentId?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly pollTimeoutSec: number;
  readonly editIntervalMs: number;
  readonly apiBase: string;
}

const TelegramSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Who may talk to this bot: `<telegramId>` or `<telegramId>|<label>`.
   *
   * One list for both kinds of id, which works because Telegram numbers them
   * apart: a user id is positive and a group id is negative. A negative entry
   * admits that group, and inside one **both** have to be listed — the group
   * and the person typing. A list of chats alone would hand the agent to
   * everyone else in the room.
   *
   * The label half is for whoever reads the config file and the logs; nothing
   * matches on it.
   */
  allowlist: z.array(z.string().min(1)).default([]),
  /**
   * Who may run the commands that reach past their own conversation.
   *
   * `/model` moves this process onto another model for *every* surface, and
   * `/workspace rm|move` rewrites where sessions live. Empty means everyone on
   * the allowlist, so a single-operator install never notices this exists.
   */
  admins: z.array(z.string().min(1)).default([]),
  /** The agent a conversation started here is bound to. */
  agentId: z.string().min(1).optional(),
  /** The workspace a conversation started here is created in. */
  workspaceId: z.string().min(1).optional(),
  pollTimeoutSec: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(DEFAULT_POLL_TIMEOUT_SEC),
  /**
   * The floor between two edits of the same turn's message.
   *
   * Telegram allows roughly one message per second per chat, and every channel
   * shares one delivery chain — so an edit storm in one conversation is a stall
   * in all of them.
   */
  editIntervalMs: z.number().int().nonnegative().default(2000),
  /** Overridden only by a test or a proxy. */
  apiBase: z.string().min(1).default('https://api.telegram.org'),
});

/**
 * Reads the block, or says what is wrong with it.
 *
 * Throws rather than falling back to defaults: a channel that quietly ignored
 * a misspelled `allowlist` would come up answering nobody, or — worse, if the
 * misspelling were the other way — answering everybody.
 */
export function parseTelegramSettings(
  settings: Readonly<Record<string, unknown>>,
): TelegramSettings {
  const parsed = TelegramSettingsSchema.safeParse(settings);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(`channels.telegram is not usable — ${detail}`);
}
