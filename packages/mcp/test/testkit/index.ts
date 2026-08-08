/**
 * The MCP testkit, as a package subpath.
 *
 * `@ghostbot/runtime` is the second consumer: proving that a settings save
 * reconciles the right servers means driving a connector, and the composition
 * root's tests have no more business spawning a subprocess than this package's
 * do. It imports no `vitest`, so nothing here reaches a runtime graph.
 */

export { manualClock, type ManualClock } from './clock.js';
export {
  ECHO_TOOL,
  fakeServer,
  type FakeCall,
  type FakeServer,
} from './fake-server.js';
