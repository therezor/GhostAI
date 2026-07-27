/**
 * A channel with no network, kept as the worked example of the contract.
 *
 * See `loopback.ts` for the four things a channel does. `loopback.test.ts` runs
 * `channelConformance` against it and then puts a message through a real
 * `SessionHub`, a real `AgentLoop` and a real `SessionStore` — which is what
 * makes "a channel turn is the same turn a browser gets" a checked claim rather
 * than an architectural intention.
 */

export {
  loopbackChannel,
  type LoopbackChannel,
  type LoopbackEntry,
  type LoopbackOptions,
} from './loopback.js';
