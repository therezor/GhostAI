/**
 * @ghostai/runtime — config in, a running agent out.
 *
 * One package, one job: hold the wiring that every entry point needs and none
 * of them should own. `ghost chat`, the HTTP server, a channel and the
 * scheduler all want the same provider resolution, the same credential order,
 * the same jail and the same loop — and the Python original is the argument for
 * this package existing, having implemented that wiring once per entry point
 * and drifted between them.
 *
 * **No HTTP, and nothing above `@ghostai/agent`.** A transport builds a runtime;
 * a runtime never knows what is driving it.
 */

export {
  PROVIDER_CREDENTIAL_NAMESPACE,
  findCredential,
  openVault,
} from './credentials.js';

export { mergeConfigPatch } from './merge.js';

export {
  assertWritableAgentIds,
  hasAgent,
  listAgents,
  pruneDanglingSubagents,
  resolveAgent,
  resolveAgentOrDefault,
  resolveAgents,
  toolPromptWarnings,
  type AgentConfigWarning,
  type AgentMissReason,
  type EffectiveAgent,
} from './agents.js';

export { JailCache, MAX_CACHED_JAILS } from './jail-cache.js';

export { LoopCache, MAX_CACHED_LOOPS } from './loop-cache.js';

export { registryToolSink } from './tool-sink.js';

export {
  ProviderCache,
  providerCacheKey,
  type ProviderRequest,
} from './provider-cache.js';

export {
  createRuntime,
  type GhostRuntime,
  type RuntimeOptions,
} from './runtime.js';

export {
  OWNER_LABEL,
  ToolboxPool,
  dockerEngine,
  ownerProcessLooksAlive,
  ownerTag,
  type ContainerEngine,
  type ToolboxPoolOptions,
} from './toolbox-pool.js';
