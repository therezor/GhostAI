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
 *
 * It is up here with the other helpers rather than beside `ConfigPatchSchema`
 * because an agent's own settings are a patch over `agents.defaults` — the
 * inherit-unless-set shape is not only a wire concern.
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

// ---------------------------------------------------------------------------
// Agent defaults
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
  /**
   * `auto` runs the resolution order; otherwise a provider *instance* id.
   *
   * A bare provider type is still accepted and means "any instance of that
   * type, or a default one if none is configured" — which is what keeps
   * `ghost chat --provider ollama` working on a machine with no config file.
   */
  provider: z.string().min(1).default('auto'),
  maxTokens: z.number().int().positive().default(8192),
  contextWindowTokens: z.number().int().positive().default(65_536),
  /**
   * Optional, and unset is not the same as `0`.
   *
   * Unset means the request carries no `temperature` at all and the provider
   * applies its own — which is the only correct answer for the models that
   * reject the parameter outright, and the honest one for the rest, since a
   * default here is this project's guess at someone else's tuning. The range is
   * also not universal: most providers cap at 2, some at 1, and a few reasoning
   * models accept nothing but their own. So the setting is "say nothing unless
   * you mean it", exactly like `reasoningEffort` beside it.
   */
  temperature: z.number().min(0).max(2).optional(),
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

// The named agents that inherit from those defaults live further down, after
// the tool schemas they override — see "Agents".

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * One configured endpoint. API keys are deliberately absent: they live in the
 * encrypted `CredentialVault` under the `providers` namespace, keyed by the
 * *instance* id, so a `config.json` is safe to commit or paste into a bug
 * report.
 *
 * `type` is what makes an instance distinct from a provider. Two Ollama servers
 * — a laptop and a GPU box — are two entries with the same `type` and different
 * `apiBase`, which the previous shape (one entry per provider id) could not
 * express at all. It is validated against the registry table by
 * `@ghostai/providers`, not here: this package sits upstream of that table and
 * cannot see it, which is the same reason `ProvidersConfig` is a record rather
 * than one named field per provider.
 */
export const ProviderConfigSchema = z.object({
  /** A `@ghostai/providers` registry id — `ollama`, `openai`, `custom`. */
  type: z.string().min(1),
  /** Shown in the UI. Empty falls back to the type's display name. */
  label: z.string().default(''),
  apiBase: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  /**
   * Models to offer for this instance.
   *
   * A fallback rather than the catalogue: an endpoint that answers `GET /models`
   * is enumerated live, and this is what an operator typed for one that does
   * not — or what is offered while a server is unreachable.
   */
  models: z.array(z.string()).default([]),
  /** A disabled instance is kept, and skipped by resolution and model listing. */
  enabled: z.boolean().default(true),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Keyed by *instance* id, which is an operator's label rather than a provider id.
 *
 * It used to be keyed by provider id, which capped the tree at one endpoint per
 * provider. The two are deliberately compatible: an old file's keys *are*
 * provider ids, so the migration in `@ghostai/core` only has to write
 * `type` = the key, and every credential already in the vault keeps resolving
 * under the same string.
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
// Agents
// ---------------------------------------------------------------------------
//
// Below the tool schemas rather than beside `AgentDefaults`, because an agent
// overrides them: this is the one place in the tree where the dependency runs
// from an agent to the tools rather than the other way round.

/**
 * Which tools an agent may call.
 *
 * Empty `allow` means "everything not denied", matching `ExecToolConfig`'s
 * allow-list convention — the alternative, empty meaning "nothing", turns a
 * newly created agent into one that cannot do anything and looks broken.
 * `deny` wins over `allow`, so a blanket allow-list cannot resurrect a tool an
 * operator switched off.
 */
export const AgentToolsSelectionSchema = z.object({
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});
export type AgentToolsSelection = z.infer<typeof AgentToolsSelectionSchema>;

/**
 * Where an agent's `exec` calls run.
 *
 * `host` is the behaviour that has always existed: a child process on the
 * machine running GhostAI, inside the workspace jail. `docker` is accepted by
 * the schema but has no backend yet, and is refused when the runtime resolves
 * the agent — a config that parses and then fails a turn much later would be
 * worse than one that fails the save.
 */
export const AgentSandboxSchema = z.object({
  kind: z.enum(['host', 'docker']).default('host'),
  image: z.string().default(''),
  /** Where the workspace is mounted inside the container. */
  workdir: z.string().default('/workspace'),
  network: z.boolean().default(false),
});
export type AgentSandbox = z.infer<typeof AgentSandboxSchema>;

export const AgentMemoryScopeSchema = z.object({
  /** Also read the layer shared by every agent working in this folder. */
  shared: z.boolean().default(true),
});
export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;

/**
 * One named agent.
 *
 * Built on `patchOf(AgentDefaultsSchema)` rather than restating the fields, so
 * every knob is inherit-unless-set and a field added to `AgentDefaults` later
 * becomes per-agent overridable without touching this schema.
 *
 * `workspace` is omitted deliberately. The working folder is a property of the
 * session, shared by every agent that opens it; an agent able to pin its own
 * would break the one thing this feature is built around — several agents, one
 * folder, separate identities.
 */
export const AgentEntrySchema = patchOf(AgentDefaultsSchema)
  .omit({ workspace: true })
  .extend({
    /** Shown in the UI. Empty falls back to the id. */
    label: z.string().default(''),
    /**
     * This agent's whole static system prompt, as a template.
     *
     * Not an addition to a built-in block — it replaces one. Empty means the
     * built-in `DEFAULT_SYSTEM_PROMPT_TEMPLATE`, which is what keeps an install
     * that never customised a prompt receiving improvements to it on upgrade.
     * See `prompt.ts` for the placeholder set and the substitution rules.
     */
    systemPrompt: z.string().default(''),
    enabled: z.boolean().default(true),
    tools: AgentToolsSelectionSchema.prefault({}),
    /** Risk-band policy for this agent only; merged over `tools.approvals`. */
    approvals: patchOf(ToolApprovalsConfigSchema).optional(),
    /** Merged over `tools.exec`, so one agent can hold a tighter allow-list. */
    exec: patchOf(ExecToolConfigSchema).optional(),
    sandbox: AgentSandboxSchema.prefault({}),
    memory: AgentMemoryScopeSchema.prefault({}),
  });
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

/**
 * `defaults` is what every agent inherits and what an install with no named
 * agents runs as. `list` is keyed by an id the operator chooses, which also
 * names the agent's directory on disk — so it follows the workspace id rules.
 */
export const AgentsConfigSchema = z.object({
  defaults: AgentDefaultsSchema.prefault({}),
  list: z.record(z.string(), AgentEntrySchema).default({}),
});
export type AgentsConfig = z.infer<typeof AgentsConfigSchema>;

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
  agentId: z.string().optional(),
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
 * A settings patch from the UI or CLI.
 *
 * Deep-partial rather than `ConfigSchema.partial()`: the settings panel saves
 * one section at a time, so `{ agents: { defaults: { temperature: 0.5 } } }`
 * must validate without restating the sibling fields — and must not invent them.
 */
export const ConfigPatchSchema = z.object({
  agents: z
    .object({
      defaults: patchOf(AgentDefaultsSchema).optional(),
      /**
       * `null` deletes the agent; an object creates or updates one. Same
       * reasoning as `providers` below — an absent key means "not mentioned",
       * so removing an agent needs a syntax the merge can tell apart.
       *
       * The nested blocks are restated as patches for the same reason `tools`
       * is below: `patchOf` is not recursive, so without this an operator
       * toggling `sandbox.network` would have to resend the image, the workdir
       * and the kind alongside it.
       */
      list: z
        .record(
          z.string(),
          patchOf(AgentEntrySchema)
            .extend({
              tools: patchOf(AgentToolsSelectionSchema).optional(),
              sandbox: patchOf(AgentSandboxSchema).optional(),
              memory: patchOf(AgentMemoryScopeSchema).optional(),
            })
            .nullable(),
        )
        .optional(),
    })
    .optional(),
  /**
   * `null` deletes the instance; an object creates or updates one.
   *
   * Deletion needs a syntax of its own because the merge treats an absent key
   * as "not mentioned" — there is otherwise no way to remove a provider the
   * operator added. `mergeConfigPatch` honours the null only under the paths in
   * its `DELETE_BY_NULL` list, so it cannot be used to punch a hole in a struct.
   *
   * `patchOf` makes `type` optional, which is right for editing an instance
   * that already has one. Creating an instance without naming a type fails the
   * merged tree's re-parse, which is a 400 saying exactly that.
   */
  providers: z.record(z.string(), patchOf(ProviderConfigSchema).nullable()).optional(),
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
