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
 * `channelConformance` lives in `src/testkit/` and is deliberately not exported
 * here: it imports `vitest`, and shipping a test framework in the runtime graph
 * is the same mistake the provider and tool suites already avoid. Channels
 * import it by path.
 */

export {
  DEFAULT_ACCEPTED_KINDS,
  type Channel,
  type ChannelContext,
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

export { TurnProjection, type OutboundDraft, type TurnProjectionOptions } from './projection.js';
