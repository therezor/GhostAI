/**
 * `@ghostai/channels/testkit` — the conformance suite and the hub it runs on.
 *
 * A subpath rather than part of the package entry, because it imports `vitest`
 * and nothing in a running GhostAI should. It is exported at all — unlike the
 * provider and tool suites, which adapters import relatively from inside their
 * own package — because a channel is the one implementation that will routinely
 * live outside this repo, and a contract an external channel cannot run against
 * is a contract that only holds for the channels that were already here.
 */

export { channelConformance, type ChannelConformanceOptions } from './conformance.js';

export {
  ScriptedConnection,
  ScriptedHub,
  type ReceivedFrame,
  type ScriptedHubOptions,
} from './hub.js';
