/**
 * @ghostai/extension-host — third-party code, authorised and loaded.
 *
 * An extension is a directory under `~/.ghostai/extensions` holding a
 * `ghostai.extension.json` and the ESM entry it names. This package finds it,
 * asks `@ghostai/security` whether the bytes on disk are the ones an operator
 * approved, imports it, calls `activate`, and holds on to what that call asked
 * for.
 *
 * It sits above every registry an extension can write into and below the
 * composition root that applies them. That placement is the reason it is a
 * package rather than a module in `@ghostai/runtime`: an extension may
 * contribute a `ChannelFactory`, so something has to name `@ghostai/channels`,
 * and `runtime` has no business importing it — channels are wired in
 * `ghost serve`, one layer further out again.
 *
 * The three things worth reading before changing anything here:
 *
 *  - **`ExtensionContext` is a recorder, not the registries.** `extension.ts`
 *    says what that buys.
 *  - **`reconcile` never throws.** `host.ts` says why a boot must survive an
 *    extension that does not.
 *  - **The digest covers the code, not the manifest.** That is
 *    `@ghostai/security`'s `extension.ts`, and it is the difference between
 *    approving a directory and approving a pointer to one.
 */

export {
  type CommandInput,
  type CommandResult,
  type Extension,
  type ExtensionCommand,
  type ExtensionContext,
} from './extension.js';

export {
  EXTENSION_TOOL_PREFIX,
  RegistrationBag,
  extensionToolName,
  type ProviderRegistration,
  type Registration,
} from './registration.js';

export { importExtension, type ExtensionLoader } from './loader.js';

export { ExtensionHost, type ExtensionHostOptions } from './host.js';
