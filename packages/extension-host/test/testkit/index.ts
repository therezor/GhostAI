/**
 * The extension testkit, as a package subpath.
 *
 * Every consumer of this one is out of tree by definition: an extension lives
 * in its own repository, and the contract it has to satisfy — activate cleanly,
 * namespace what it registers, declare what it contributes — is only checkable
 * against the host's own recorder. A suite importable from inside this package
 * alone would verify nothing that is not already verified by `host.test.ts`.
 *
 * It stays off the package entry rather than being re-exported from
 * `src/index.ts`: this module imports `vitest`, and the entry is in the runtime
 * dependency graph of everything downstream. Reaching it by subpath is a test
 * runner asking for it by name.
 */

export {
  extensionConformance,
  type ExtensionConformanceOptions,
} from './conformance.js';
