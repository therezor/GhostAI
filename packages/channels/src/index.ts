/**
 * @ghostai/channels — every way into the agent that is not a browser.
 *
 * The package is three things: a contract a transport implements, a manager
 * that bridges `MessageBus` to the session hub, and one channel over that
 * contract — Telegram, which ships in the box.
 *
 * That third part used to say "there is no Telegram here", and the property it
 * was protecting is worth restating now that there is, because it survived:
 * **the built-in consumes exactly the `ChannelFactory` contract a plugin
 * would**. It is registered by `ghost serve` like any other factory, it reaches
 * nothing a plugin could not reach, and `channelConformance` — the suite
 * written for implementations outside this repository — runs against it. The
 * contract cannot rot into "whatever the built-in needed", because the built-in
 * is held to the contract by the same test everyone else is.
 *
 * The two things Telegram needs that the contract does not give every channel
 * are stated where they are used rather than smuggled in here: `control` is a
 * member of `ChannelContext` because *any* transport that can answer an
 * approval needs it, and `TelegramConsole` is a factory option, not a context
 * member, because a channel never sees a session store.
 *
 * It depends on `protocol` and `core` alone. The hub is stated as a structural
 * port, so nothing here imports the HTTP server, and a channel therefore has no
 * path to the agent loop, the session store or a Fastify instance — only the
 * `publish` and `control` functions it was handed.
 *
 * `channelConformance` is deliberately absent from this entry point. It imports
 * `vitest`, and shipping a test framework in the runtime graph is the same
 * mistake the provider and tool suites already avoid. It lives in
 * `test/testkit/` — outside `src` entirely, so `tsup` never sees it and there is
 * nothing for a bundler to pull in by accident — and reaches implementors as the
 * `@ghostai/channels/testkit` subpath, which resolves straight to TypeScript
 * source. `examples/loopback-channel` is what runs it.
 */

export {
  DEFAULT_ACCEPTED_KINDS,
  type Channel,
  type ChannelContext,
  type ChannelControl,
  type ChannelControlFrame,
  type ChannelFactory,
  type ChannelInbound,
} from './channel.js';

export {
  ChannelManager,
  type ChannelHub,
  type ChannelHubConnectOptions,
  type ChannelHubConnection,
} from './manager.js';

export {
  TurnProjection,
  type ApprovalDraftDetail,
  type OutboundDraft,
  type TurnProjectionOptions,
} from './projection.js';

export {
  telegramChannel,
  type TelegramChannel,
  type TelegramChannelOptions,
  type MemoryState,
  type SkillSummary,
  type SkillsState,
  type TelegramConsole,
  type TelegramSettings,
} from './telegram/index.js';
