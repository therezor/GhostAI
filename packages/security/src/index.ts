/**
 * @ghostai/security — the package that has to be right.
 *
 * It exists as its own package for two reasons. The first is the coverage gate:
 * 95% lines *and* branches, because an untested branch in a guard is not a bug
 * waiting to be reported, it is a bypass waiting to be found — and a guard whose
 * failure mode is "allows everything" gives no sign that its tests never ran it.
 * The second is auditability. Everything that decides whether an agent may touch
 * a path, reach a host, spawn a process, run in a container or read a
 * credential is in these six modules and nowhere else, so reviewing the security surface means reading one
 * package rather than grepping for `fetch` across a repo.
 *
 * The layering that makes that true is enforced mechanically: `@ghostai/core`
 * may not use the network or `child_process` at all, so there is no way to reach
 * either without coming through here first.
 *
 * The five guards, and the class of attack each one closes:
 *
 *  - `WorkspaceJail` — path traversal and symlink escape, by normalising every
 *    input into the workspace root lexically and then canonicalising through
 *    `realpath` before deciding containment.
 *  - `wrapToolOutput` — prompt injection, by fencing untrusted output inside a
 *    per-turn random delimiter. Detection is non-destructive: content passes
 *    through byte-for-byte and a `notice` raises the badge.
 *  - `guardedFetch` — SSRF and DNS rebinding, by pinning the addresses that
 *    validation resolved into the dispatcher that connects, and re-validating
 *    every redirect hop.
 *  - `guardExec` — command injection, by taking `argv: string[]`, jailing every
 *    path-shaped argument, and refusing the shell invocations that would put a
 *    parser back in the middle.
 *  - `CredentialVault` — credential theft at rest, with AES-256-GCM under a key
 *    from the OS keychain or a `0600` keyfile.
 *  - `parseToolbox` / `assertToolboxPolicy` — an agent choosing its own
 *    toolbox, by making the image and its capability set a hash-authorised
 *    manifest an operator installs rather than a field any config patch could
 *    reach.
 */

export {
  WorkspaceJail,
  pathShapes,
  singleJail,
  type JailAccept,
  type JailCheck,
  type JailRejection,
  type JailResolver,
  type PathShape,
  type WorkspaceJailOptions,
} from './jail.js';

export {
  INJECTION_SIGNALS,
  TOOL_OUTPUT_NONCE_BYTES,
  TOOL_OUTPUT_TAG_PREFIX,
  createToolOutputNonce,
  describeInjectionFindings,
  detectPromptInjection,
  toolOutputPolicy,
  toolOutputTag,
  toolPolicyUsesNonce,
  wrapToolOutput,
  type InjectionFinding,
  type InjectionSignal,
  type WrapToolOutputOptions,
  type WrappedToolOutput,
} from './nonce.js';

export {
  BLOCKED_RANGES,
  cidrContains,
  classifyAddress,
  parseCidr,
  parseIpLiteral,
  type AddressCategory,
  type AddressRange,
  type IpFamily,
  type ParsedCidr,
  type ParsedIp,
} from './ip.js';

export {
  TOOLBOX_DOCS_MAX_BYTES,
  ToolboxStore,
  type ApprovedToolbox,
  type ToolboxListing,
  type ToolboxStoreOptions,
} from './toolbox-store.js';

export {
  BUILTIN_TOOL_NAMES,
  FORBIDDEN_CAPABILITIES,
  IMAGE_DIGEST_PATTERN,
  assertNetworkWithinCeiling,
  assertToolboxPolicy,
  effectiveNetwork,
  manifestHash,
  parseToolbox,
  weakenedIn,
  type EffectiveNetwork,
} from './toolbox.js';

export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  guardedFetch,
  pinnedLookup,
  systemResolver,
  validateTarget,
  type DnsResolver,
  type FetchImplementation,
  type GuardedFetchOptions,
  type GuardedFetchResult,
  type NetworkPolicy,
  type PinnedAddress,
  type PinnedTarget,
} from './fetch.js';

export {
  SHELL_BINARIES,
  binaryName,
  createOutputCap,
  guardExec,
  type ExecGuardOptions,
  type ExecPlan,
  type OutputCap,
  type OutputCapResult,
} from './exec-guard.js';

export {
  CredentialVault,
  VAULT_KEY_BYTES,
  keyFileStore,
  keychainStore,
  resolveVaultKey,
  systemCommandRunner,
  type CommandResult,
  type CommandRunner,
  type CredentialVaultOptions,
  type KeyFileStoreOptions,
  type KeyStore,
  type KeychainStoreOptions,
  type ResolveVaultKeyOptions,
  type ResolvedVaultKey,
} from './vault.js';

export { systemRandom, type RandomSource } from './random.js';
