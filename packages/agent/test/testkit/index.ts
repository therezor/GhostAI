/**
 * The loop's test doubles, as a subpath entry.
 *
 * `scriptedProvider` was written for `loop.test.ts` and imported relatively;
 * the end-to-end suite is its second consumer, and it is a consumer in another
 * package. The alternative was a second implementation of the same event
 * shaping over there — which would let the model the browser test drives behave
 * differently from the model every loop test asserts against, and the whole
 * point of a scripted provider is that those are the same thing.
 *
 * Nothing here imports `vitest`, so this entry does not pull a test framework
 * into anyone's graph. That is what separates it from the provider and tool
 * conformance suites, which stay internal for exactly that reason.
 */

export { manualClock, type ManualClock } from './clock.js';
export {
  scriptedProvider,
  toolCall,
  type ScriptedProvider,
  type ScriptedTurn,
} from './provider.js';
