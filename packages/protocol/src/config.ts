/**
 * The settings tree.
 *
 * Conventions:
 *
 *  - **`0` means "no limit"** on every `*TimeoutMs` and `*PerMinute` field, so
 *    a limit can be disabled without a separate nullable flag.
 *  - **Durations are named with their unit.** A bare `toolTimeout: 40` is
 *    ambiguous between seconds and milliseconds at every call site;
 *    `toolTimeoutMs` is not.
 *  - **Every nested object uses `.prefault({})`**, so `ConfigSchema.parse({})`
 *    yields a fully-populated tree. The empty object is fed *through* the child
 *    schema so the child's own defaults apply, which `.default()` (output-typed
 *    in Zod 4) could not do without restating every leaf.
 *  - **No `.transform()` anywhere.** Normalisation (trimming an `apiBase` to
 *    `undefined`, expanding `~`) happens at load time in `@ghostai/core`, which
 *    keeps input and output types identical and every schema here
 *    representable as JSON Schema for the OpenAPI document.
 */

import { z } from 'zod';

import { ToolApprovalPolicySchema } from './tools.js';

/** A duration in milliseconds where `0` disables the limit. */
const OptionalDurationMs = z.number().int().nonnegative();

export const ReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high']);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export const AgentDefaultsSchema = z.object({
  /**
   * Empty means `<root>/workspace`, where the root is `GHOSTAI_HOME` or
   * `~/.ghostai`.
   *
   * Deliberately *not* defaulted to the literal `~/.ghostai/workspace`: that
   * string restates the default root, so an install that moved its root with
   * `GHOSTAI_HOME` would keep a workspace back under the home directory —
   * silently pointing the agent's filesystem tools at a tree the operator
   * thought they had relocated. A relative path here is resolved against the
   * root, never against the process working directory.
   */
  workspace: z.string().default(''),
  /** Empty means "resolve from whichever provider has credentials". */
  model: z.string().default(''),
  /** `auto` runs the registry's resolution order; otherwise a provider id. */
  provider: z.string().min(1).default('auto'),
  maxTokens: z.number().int().positive().default(8192),
  contextWindowTokens: z.number().int().positive().default(65_536),
  temperature: z.number().min(0).max(2).default(0.1),
  maxToolIterations: z.number().int().positive().default(40),
  toolTimeoutMs: OptionalDurationMs.default(0),
  /** Wall-clock cap on one turn, checked at the top of each loop iteration. */
  loopWallTimeoutMs: OptionalDurationMs.default(0),
  subagentTimeoutMs: OptionalDurationMs.default(0),
  reasoningEffort: ReasoningEffortSchema.optional(),
  learningEnabled: z.boolean().default(true),
  /** Turns between proactive-learning passes. */
  learningInterval: z.number().int().positive().default(10),
  memoryMaxPromptTokens: z.number().int().nonnegative().default(2000),
  memoryCompactThresholdTokens: z.number().int().nonnegative().default(1600),
  /** A cheaper model for consolidation/compaction; falls back to `model`. */
  consolidationModel: z.string().optional(),
  pinnedSkills: z.array(z.string()).default([]),
  maxPinnedSkills: z.number().int().nonnegative().default(5),
});
export type AgentDefaults = z.infer<typeof AgentDefaultsSchema>;

export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema.prefault({}),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Per-provider connection settings. API keys are deliberately absent: they live
 * in the encrypted `CredentialVault` under the `providers` namespace, so a
 * `config.json` is safe to commit or paste into a bug report.
 */
export const ProviderConfigSchema = z.object({
  apiBase: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  /** Overrides the registry's model list for OpenAI-compatible endpoints. */
  models: z.array(z.string()).default([]),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Keyed by provider id — a record, not one named field per provider.
 *
 * Hand-listing every provider here would mean keeping this file in sync with the
 * provider registry by discipline. The registry lives in `@ghostai/providers`,
 * which is downstream of this package, so protocol states the generic shape and
 * `@ghostai/providers` narrows it to `Record<ProviderId, ProviderConfig>` off
 * its own `PROVIDERS` table. Adding a provider stays a one-line table entry and
 * drift becomes a type error there rather than a silent gap here.
 */
export const ProvidersConfigSchema = z.record(z.string(), ProviderConfigSchema).default({});
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const AuthConfigSchema = z.object({
  /**
   * Disabling auth on a non-loopback bind is a startup *error*, not a warning —
   * see `isLoopbackHost`. A warning is not enough: it scrolls past, and the
   * result is an unauthenticated shell-capable agent on a LAN address.
   */
  enabled: z.boolean().default(true),
  sessionTtlMs: z
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60 * 1000),
  rateLimitPerMinute: OptionalDurationMs.default(0),
  /** Lifetime of the HMAC-signed URLs that serve workspace media to `<img>`. */
  signedUrlTtlMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
});
export type AuthConfig = z.infer<typeof AuthConfigSchema>;

export const ServerConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  /**
   * One port for the API, the WebSocket and the static UI. GhostAI is
   * single-process by default; nothing in it is heavy enough to justify the
   * reconnect-and-HTTP-fallback client a split-process topology would need.
   */
  port: z.number().int().min(1).max(65_535).default(3000),
  auth: AuthConfigSchema.prefault({}),
  /** Extra browser origins allowed to hit the API. Same-origin always works. */
  corsOrigins: z.array(z.string()).default([]),
  /**
   * How many server events to retain per session so a reconnecting tab can
   * replay an in-flight turn from its last `seq` instead of losing it.
   */
  replayBufferSize: z.number().int().nonnegative().default(512),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Whether `host` binds only to the local machine.
 *
 * A pure predicate rather than a schema refinement: the caller needs to explain
 * *why* startup was refused, and cross-field validation would also make this
 * schema unrepresentable as JSON Schema. `@ghostai/server` calls it during
 * boot; `0.0.0.0` and `::` are the wildcard binds that must count as remote.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  if (h === '0.0.0.0' || h === '::' || h === '') return false;
  // 127.0.0.0/8 — any of the 16 million loopback addresses, not just .0.1.
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const WebSearchConfigSchema = z.object({
  provider: z.string().min(1).default('brave'),
  baseUrl: z.string().default(''),
  maxResults: z.number().int().positive().default(5),
});
export type WebSearchConfig = z.infer<typeof WebSearchConfigSchema>;

export const WebToolsConfigSchema = z.object({
  proxy: z.string().optional(),
  search: WebSearchConfigSchema.prefault({}),
});
export type WebToolsConfig = z.infer<typeof WebToolsConfigSchema>;

export const ExecToolConfigSchema = z.object({
  enable: z.boolean().default(true),
  timeoutMs: OptionalDurationMs.default(0),
  pathAppend: z.string().default(''),
  /**
   * `argv[0]` allow-list. Empty means "anything not denied" — the deny list and
   * the workspace jail still apply.
   *
   * Note what is *not* here: patterns for `$(...)`, backticks or `| sh`. The
   * exec tool takes `argv: string[]` and runs `execFile` with `shell: false`,
   * so there is no string for a shell metacharacter to live in. Scanning for
   * them would reject legitimate commands while blocking nothing.
   */
  allowedBinaries: z.array(z.string()).default([]),
  deniedBinaries: z.array(z.string()).default([]),
  /** Environment variables passed through to the child. */
  envAllowlist: z.array(z.string()).default(['PATH', 'HOME', 'LANG', 'TZ']),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .default(1024 * 1024),
  installAudit: z.boolean().default(true),
  installAuditTimeoutMs: OptionalDurationMs.default(0),
  installAuditBlockSeverity: z.enum(['low', 'moderate', 'high', 'critical']).default('high'),
});
export type ExecToolConfig = z.infer<typeof ExecToolConfigSchema>;

export const McpOAuthConfigSchema = z.object({
  authUrl: z.string().min(1),
  tokenUrl: z.string().min(1),
  clientId: z.string().min(1),
  scopes: z.array(z.string()).default([]),
  callbackTimeoutMs: OptionalDurationMs.default(0),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;

export const McpTransportSchema = z.enum(['stdio', 'sse', 'streamableHttp']);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerConfigSchema = z.object({
  /** Inferred from `command` vs `url` when omitted. */
  type: McpTransportSchema.optional(),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  url: z.string().default(''),
  headers: z.record(z.string(), z.string()).default({}),
  oauth: McpOAuthConfigSchema.optional(),
  toolTimeoutMs: OptionalDurationMs.default(0),
  /** `["*"]` exposes everything the server advertises. */
  enabledTools: z.array(z.string()).default(['*']),
  enabled: z.boolean().default(true),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Risk band → policy. The default asks before `exec` and network egress and
 * allows reads and jailed writes, which is the split an operator running a
 * self-hosted agent on their own machine actually wants.
 */
export const ToolApprovalsConfigSchema = z.object({
  safe: ToolApprovalPolicySchema.default('allow'),
  write: ToolApprovalPolicySchema.default('allow'),
  exec: ToolApprovalPolicySchema.default('ask'),
  network: ToolApprovalPolicySchema.default('ask'),
  /** How long to wait for a UI decision before treating the call as denied. */
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
});
export type ToolApprovalsConfig = z.infer<typeof ToolApprovalsConfigSchema>;

export const ToolsConfigSchema = z.object({
  web: WebToolsConfigSchema.prefault({}),
  exec: ExecToolConfigSchema.prefault({}),
  approvals: ToolApprovalsConfigSchema.prefault({}),
  restrictToWorkspace: z.boolean().default(true),
  /** Head+tail truncation budget for a single tool result. */
  maxOutputChars: z.number().int().positive().default(8192),
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
});
export type ToolsConfig = z.infer<typeof ToolsConfigSchema>;

// ---------------------------------------------------------------------------
// Audio, RAG, scheduler, channels, plugins
// ---------------------------------------------------------------------------

export const AudioConfigSchema = z.object({
  providerUrl: z.string().optional(),
  model: z.string().default('whisper-large-v3-turbo'),
  ttsEnabled: z.boolean().default(false),
  ttsProvider: z.string().default('browser'),
  ttsVoice: z.string().default('en_female'),
  ttsSpeed: z.number().positive().default(1.0),
  ttsLang: z.string().default('en'),
  ttsModelPath: z.string().optional(),
});
export type AudioConfig = z.infer<typeof AudioConfigSchema>;

export const RagConfigSchema = z.object({
  /** Embedder backend. `local` is Ollama `/api/embed`. */
  provider: z.string().min(1).default('local'),
  apiBase: z.string().default(''),
  model: z.string().default('nomic-embed-text'),
  chunkSize: z.number().int().positive().default(1024),
  chunkOverlap: z.number().int().nonnegative().default(128),
  topK: z.number().int().positive().default(8),
  /**
   * Reciprocal-rank-fusion constant for blending BM25 and vector rankings.
   * 60 is the value from the original RRF paper.
   */
  rrfK: z.number().int().positive().default(60),
  hybrid: z.boolean().default(true),
});
export type RagConfig = z.infer<typeof RagConfigSchema>;

export const HeartbeatConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMin: z.number().int().positive().default(30),
  /** A cheap model is the point — this runs every 30 minutes forever. */
  model: z.string().optional(),
  sessionKey: z.string().min(1).default('heartbeat:default'),
  /** Path relative to the workspace. */
  file: z.string().min(1).default('TASK.md'),
  /** Channel id → destination address. */
  targets: z.record(z.string(), z.string()).default({}),
  profileId: z.string().optional(),
});
export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

export const SchedulerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Concurrent automation runs. Two keeps a slow job from blocking the queue. */
  concurrency: z.number().int().positive().default(2),
  /** Run `at` jobs whose time passed while the process was down. */
  catchUpOnBoot: z.boolean().default(true),
  heartbeat: HeartbeatConfigSchema.prefault({}),
});
export type SchedulerConfig = z.infer<typeof SchedulerConfigSchema>;

/**
 * Channel settings. Loose by design: each channel — built-in or plugin — parses
 * its own block, so installing a channel plugin does not require a schema
 * change here. Telegram ships in the box but consumes the same `ChannelFactory`
 * contract a plugin would, so the contract cannot rot.
 */
export const ChannelsConfigSchema = z.looseObject({
  sendProgress: z.boolean().default(true),
  sendToolHints: z.boolean().default(false),
});
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const PluginsConfigSchema = z.object({
  /** Explicit specs to load, bypassing `~/.ghostai/plugins` discovery. */
  load: z.array(z.string()).default([]),
  disabled: z.array(z.string()).default([]),
  /** Required before an arbitrary npm spec may be installed. */
  allowUnverified: z.boolean().default(false),
  /** Lets a later-discovered plugin shadow an earlier id instead of erroring. */
  allowOverride: z.boolean().default(false),
});
export type PluginsConfig = z.infer<typeof PluginsConfigSchema>;

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

export const ConfigSchema = z.object({
  agents: AgentsConfigSchema.prefault({}),
  providers: ProvidersConfigSchema,
  server: ServerConfigSchema.prefault({}),
  tools: ToolsConfigSchema.prefault({}),
  channels: ChannelsConfigSchema.prefault({}),
  audio: AudioConfigSchema.prefault({}),
  rag: RagConfigSchema.prefault({}),
  scheduler: SchedulerConfigSchema.prefault({}),
  plugins: PluginsConfigSchema.prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;

/**
 * Strips a `.default()` / `.prefault()` wrapper, leaving the schema underneath.
 *
 * Unconstrained on purpose: a `ZodRawShape`'s values are typed as the internal
 * `$ZodType`, so constraining to the public `z.ZodType` makes every mapped-type
 * application fail its own constraint check.
 */
type Unwrapped<T> =
  T extends z.ZodDefault<infer Inner> ? Inner : T extends z.ZodPrefault<infer Inner> ? Inner : T;

type PatchShape<S extends z.ZodRawShape> = {
  [K in keyof S]: Unwrapped<S[K]> extends z.ZodType ? z.ZodOptional<Unwrapped<S[K]>> : never;
};

/**
 * Turns a config schema into a true patch schema: every field optional **and
 * stripped of its default**.
 *
 * `.partial()` alone is not enough and is actively wrong here. It marks keys
 * optional but leaves the inner `ZodDefault` in place, so parsing `{}` returns
 * every default rather than an empty object — and since a patch is deep-merged
 * into the live config, saving one settings panel would silently rewrite every
 * field the client never mentioned back to its default.
 */
function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>): z.ZodObject<PatchShape<S>> {
  const shape: Record<string, z.ZodType> = {};
  const fields = schema.shape as unknown as Record<string, z.ZodType>;
  for (const [key, field] of Object.entries(fields)) {
    const type = field.def.type;
    const base =
      type === 'default' || type === 'prefault'
        ? (field as z.ZodDefault<z.ZodType>).unwrap()
        : field;
    shape[key] = base.optional();
  }
  // The mapped type above states the result precisely; the loop cannot express it.
  return z.object(shape) as unknown as z.ZodObject<PatchShape<S>>;
}

/**
 * A settings patch from the UI or CLI.
 *
 * Deep-partial rather than `ConfigSchema.partial()`: the settings panel saves
 * one section at a time, so `{ agents: { defaults: { temperature: 0.5 } } }`
 * must validate without restating the sibling fields — and must not invent them.
 */
export const ConfigPatchSchema = z.object({
  agents: z.object({ defaults: patchOf(AgentDefaultsSchema).optional() }).optional(),
  providers: z.record(z.string(), patchOf(ProviderConfigSchema)).optional(),
  server: patchOf(ServerConfigSchema)
    .extend({ auth: patchOf(AuthConfigSchema).optional() })
    .optional(),
  tools: patchOf(ToolsConfigSchema)
    .extend({
      web: patchOf(WebToolsConfigSchema)
        .extend({ search: patchOf(WebSearchConfigSchema).optional() })
        .optional(),
      exec: patchOf(ExecToolConfigSchema).optional(),
      approvals: patchOf(ToolApprovalsConfigSchema).optional(),
    })
    .optional(),
  /**
   * Loose, unlike the rest: a channel plugin's config block is an unknown key
   * here, and a stripping patch schema would drop it on every save.
   */
  channels: z
    .looseObject({
      sendProgress: z.boolean().optional(),
      sendToolHints: z.boolean().optional(),
    })
    .optional(),
  audio: patchOf(AudioConfigSchema).optional(),
  rag: patchOf(RagConfigSchema).optional(),
  scheduler: patchOf(SchedulerConfigSchema)
    .extend({ heartbeat: patchOf(HeartbeatConfigSchema).optional() })
    .optional(),
  plugins: patchOf(PluginsConfigSchema).optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;
