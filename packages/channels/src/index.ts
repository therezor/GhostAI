/**
 * @ghostai/channels — every way into the agent that is not a browser.
 *
 * The package is two things and no more: a contract a transport implements, and
 * a manager that bridges `MessageBus` to the session hub. There is no Telegram
 * here, no Discord, no WhatsApp — those are channels *over* this contract, and
 * the first one to ship consumes exactly what a plugin would, so the contract
 * cannot rot into "whatever the built-in needed".
 *
 * It depends on `protocol` and `core` alone. The hub is stated as a structural
 * port, so nothing here imports the HTTP server, and a channel therefore has no
 * path to the agent loop, the session store or a Fastify instance — only the
 * `publish` function it was handed.
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
  DEFAULT_MAX_CHANNEL_SESSIONS,
  type ChannelHub,
  type ChannelHubConnectOptions,
  type ChannelHubConnection,
  type ChannelManagerOptions,
} from './manager.js';

export {
  TurnProjection,
  type ApprovalDraftDetail,
  type OutboundDraft,
  type TurnProjectionOptions,
} from './projection.js';
