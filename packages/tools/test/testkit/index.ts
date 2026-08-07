/**
 * The tool testkit, as a package subpath.
 *
 * `toolConformance` says a tool is a tool "built-in, extension-supplied, or proxied
 * from an MCP server" — and the second and third of those live in other
 * packages. A suite importable only from inside this one would leave the
 * contract unverified in exactly the place it matters most, which is the
 * argument `channelConformance` already won.
 *
 * It stays off the package entry rather than being re-exported from
 * `src/index.ts`: this module imports `vitest`, and the entry is in the runtime
 * dependency graph of everything downstream. Reaching it by subpath is a test
 * runner asking for it by name.
 */

export { toolConformance, type ToolConformanceOptions } from './conformance.js';

export { createTestWorkspace, type TestWorkspace } from './workspace.js';
