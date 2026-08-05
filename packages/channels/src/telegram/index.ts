/**
 * The Telegram channel, as the composition root consumes it.
 *
 * A narrow surface on purpose: a factory, the port it needs filled, and the
 * settings type. Everything else — the Bot API, the command table, the callback
 * store, the renderer — is this module's own business and is reachable only
 * from inside it, which is what keeps "shipped in the box" from meaning "part
 * of the contract".
 */

export {
  telegramChannel,
  type TelegramChannel,
  type TelegramChannelOptions,
} from './channel.js';
export type { MemoryState, TelegramConsole } from './console.js';
export type { TelegramSettings } from './settings.js';
