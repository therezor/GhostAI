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

import {
  ToolPermissionSchema,
  ToolPermissionsSchema,
  ToolPromptOverridesSchema,
  type ToolPermission,
  type ToolPermissions,
} from './tools.js';

/** A duration in milliseconds where `0` disables the limit. */
const OptionalDurationMs = z.number().int().nonnegative();

/**
 * How hard to ask the model to think, where `off` is a value and unset is not.
 *
 * The distinction is the whole point of having `off` at all. Unset means the
 * request carries no reasoning parameter and the provider applies its own —
 * which is the only thing that works against an endpoint that rejects the field
 * outright. `off` is a statement: this model thinks by default and I do not
 * want it to, so send whatever this wire spells that as. What that is per
 * endpoint lives in `ProviderSpec.reasoningOffBody`.
 */
export const ReasoningEffortSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
]);
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>;

/**
 * How an agent's system prompt is assembled.
 *
 * `template` is the two-half assembly: an identity template and a live-state
 * template, with the platform note, the toolbox advertisement and the
 * tool-output policy filled in as sections the operator may also replace. It is
 * the default and the one that keeps a provider's prompt cache working, because
 * everything that changes between requests sits in the tail.
 *
 * `raw` hands the whole system message to one template. Nothing is prepended or
 * appended — a `raw` prompt that wants the tool-output policy names
 * `{{toolPolicy}}`. It exists because "you own the prompt" and "you own the
 * prompt as long as you fill in our sections" are different claims, and only the
 * first one is worth making. The cost is stated in `RAW_PROMPT_PLACEHOLDERS`.
 */
export const PromptModeSchema = z.enum(['template', 'raw']);
export type PromptMode = z.infer<typeof PromptModeSchema>;

/**
 * Strips a `.default()` / `.prefault()` wrapper, leaving the schema underneath.
 *
 * Unconstrained on purpose: a `ZodRawShape`'s values are typed as the internal
 * `$ZodType`, so constraining to the public `z.ZodType` makes every mapped-type
 * application fail its own constraint check.
 */
type Unwrapped<T> =
  T extends z.ZodDefault<infer Inner>
    ? Inner
    : T extends z.ZodPrefault<infer Inner>
      ? Inner
      : T;

type PatchShape<S extends z.ZodRawShape> = {
  [K in keyof S]: Unwrapped<S[K]> extends z.ZodType
    ? z.ZodOptional<Unwrapped<S[K]>>
    : never;
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
function patchOf<S extends z.ZodRawShape>(
  schema: z.ZodObject<S>,
): z.ZodObject<PatchShape<S>> {
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
  /**
   * Empty means *unconfigured*, not "pick one for me".
   *
   * The distinction is worth stating because the neighbouring `provider` field
   * genuinely does resolve itself, and this one was documented as though it did
   * too — which put a "Resolved automatically" option in the agent editor that
   * saved an agent nothing could run. There is no model-picking code anywhere:
   * `Runtime#resolveProvider` turns an empty model into `noModelError` and
   * hands the loop a `null` provider, so `runtime.configured` goes false and
   * every turn is refused. It is the fresh-install state — the setup wizard's
   * model step is skippable — and the UI treats it as a question to answer.
   */
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
  /**
   * Whether attached images are sent to the model as images.
   *
   * Off, an attachment still reaches the model — as the path line it always
   * carries, which `read_file` and the rest resolve — but never as an `image`
   * part. That is the difference between a text-only model answering "I cannot
   * see it, let me open it" and the request being rejected outright.
   *
   * The reactive half of this already existed: `stripImages` in
   * `@ghostai/providers` removes images *after* an endpoint has refused them.
   * This is the same repair moved to before the round trip, for the case where
   * the operator already knows.
   */
  visionEnabled: z.boolean().default(true),
  /**
   * Whether the request advertises any tools at all.
   *
   * Off is not the same as denying every tool: the agent's permissions are left
   * exactly as configured and simply not offered to *this* model. Switch the
   * agent to a model that can call tools and its toolset is still there.
   *
   * It has no reactive counterpart, which is why it is here. The degradation
   * ladder deliberately never strips `tools` — a turn where the model cannot
   * act and answers from memory is a wrong answer rather than a failed request
   * — so an endpoint that cannot take a tool list has, until now, had no way to
   * be used at all.
   */
  toolsEnabled: z.boolean().default(true),
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
export const ProvidersConfigSchema = z
  .record(z.string(), ProviderConfigSchema)
  .default({});
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
  installAuditBlockSeverity: z
    .enum(['low', 'moderate', 'high', 'critical'])
    .default('high'),
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

export const ToolsConfigSchema = z.object({
  web: WebToolsConfigSchema.prefault({}),
  exec: ExecToolConfigSchema.prefault({}),
  /**
   * How long to wait for a decision before treating an `ask` call as denied.
   *
   * A timeout rather than a policy, which is why it survived the band table
   * that used to live beside it: whether a tool asks at all is now a property
   * of the agent (`agents.list.<id>.tools`), but how long the prompt stays open
   * is a property of the deployment and has nowhere else to be.
   */
  approvalTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(5 * 60 * 1000),
  restrictToWorkspace: z.boolean().default(true),
  /**
   * Head+tail truncation budget for a single tool result.
   *
   * **`.positive()`, and 0 does not mean "no limit" here** — which is worth
   * stating because it does on every duration in this tree, and because
   * `truncateHeadTail` and `historyForLLM`'s `maxToolResultChars` both read 0
   * as "do not truncate". Those two are display caps with nothing behind them.
   * This one is also an *allocation* bound: `read_file` sizes its read from it
   * (`maxOutputChars * 4` bytes, UTF-8's worst case) and allocates that buffer.
   * So 0 would make `read_file` read one byte of every file, and teaching it to
   * read the whole file instead would remove the only thing stopping one call
   * from allocating a multi-gigabyte buffer.
   *
   * An operator who wants effectively no cap sets a large number, which is
   * bounded and says what it means.
   */
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
 * Which tools an agent may call, and what happens when it does.
 *
 * One map, not a selection plus a policy. A tool the map does not mention is
 * not enabled — it never reaches the definitions the model is sent — so
 * enabling a tool and choosing its permission are one act. That is the opposite
 * of the convention next door in `ExecToolConfig.allowedBinaries`, where empty
 * means "anything not denied", and deliberately so: an allow-list of *binaries*
 * is a narrowing of one tool an operator already turned on, while this is the
 * list of tools themselves, and a newly created agent quietly holding every
 * tool the registry happens to carry is the failure this replaces.
 *
 * Which is why a new agent is not born empty either — see `DEFAULT_AGENT_TOOLS`.
 *
 * The shape is `ToolPermissionsSchema` itself rather than an alias of it: the
 * schema registry asserts every entry is a distinct object, and a second name
 * for one schema would be a `$ref` in the OpenAPI document pointing at nothing
 * the wire distinguishes. The type alias below is for readers, not for zod.
 */
export type AgentTools = ToolPermissions;

/**
 * What a newly created agent starts with: the built-in tools, at the permission
 * their risk band implies.
 *
 * The one place a risk band still turns into a permission, and it happens once,
 * at creation, where an operator can see the result and change it. Nothing
 * reads a band at call time.
 *
 * Seeding rather than starting empty because an agent that can do nothing looks
 * broken to whoever just made it — and because the alternative reading of
 * "explicit" would be a setup chore five clicks long before the first turn.
 */
export const DEFAULT_AGENT_TOOLS: Readonly<Record<string, ToolPermission>> =
  Object.freeze({
    read_file: 'allow',
    list_dir: 'allow',
    write_file: 'allow',
    edit_file: 'allow',
    exec: 'ask',
  });

/**
 * How much network an agent asks its toolbox for.
 *
 * Intersected with the profile's `network.maxMode`, never unioned: a profile is
 * a ceiling and this is a narrowing of it. An agent asking for `open` against a
 * profile whose maximum is `none` gets `none`, and the settings save that tried
 * it is refused rather than silently downgraded — a config that means something
 * other than what it says is worse than one that fails.
 *
 * `allow` is CIDRs only. A hostname allow-list is defeated by DNS rebinding,
 * which is the attack `guardedFetch` already exists to stop; a profile whose
 * traffic is all HTTP(S) scopes by hostname through the proxy instead
 * (`SandboxProfileNetwork.proxyAllowHosts`).
 */
export const AgentToolboxNetworkSchema = z.object({
  mode: z.enum(['none', 'allowlist', 'open']).default('none'),
  allow: z.array(z.string()).default([]),
});
export type AgentToolboxNetwork = z.infer<typeof AgentToolboxNetworkSchema>;

/**
 * Which toolbox an agent works in — that is, where its `exec` calls run.
 *
 * An empty `name` is the behaviour that has always existed: a child process on
 * the machine running GhostAI, inside the workspace jail. A named toolbox routes
 * `exec` into that toolbox's container instead.
 *
 * This replaces what used to be `sandbox`, because the two were one idea wearing
 * two words: "where exec runs" *is* "which box of tools the agent has".
 *
 * **There is no `image`, `runtime`, `caps` or `limits` here, deliberately.**
 * Those live in the toolbox manifest, which is installed by an operator and
 * authorised by content hash. A value with no representation in this schema
 * cannot be reached by a config patch, a settings save, or anything that later
 * gains the ability to propose one — which is what makes "the agent cannot
 * change the image it runs in" a property of the shape rather than a rule
 * somebody has to enforce.
 */
export const AgentToolboxSchema = z.object({
  /** A toolbox name, or empty to run on the host. */
  name: z.string().default(''),
  network: AgentToolboxNetworkSchema.prefault({}),
});
export type AgentToolbox = z.infer<typeof AgentToolboxSchema>;

export const AgentMemoryScopeSchema = z.object({
  /** Also read the layer shared by every agent working in this folder. */
  shared: z.boolean().default(true),
});
export type AgentMemoryScope = z.infer<typeof AgentMemoryScopeSchema>;

/**
 * Another agent this one may hand a task to.
 *
 * A subagent is not a different kind of thing from an agent — it is an ordinary
 * entry in `agents.list` that some other entry points at. That is the whole
 * design: a researcher is configured, tested and used on its own, and being
 * someone's subagent is a relationship rather than a mode. It also means the
 * model, the tool map and the toolbox a subagent runs under are already answered
 * by the entry it names, and nothing here restates them.
 *
 * Three fields, and the two that are not the id both exist because the operator
 * is the one who knows things the schema cannot:
 *
 *  - **`prompt` is the tool description the model reads.** Not a note beside it —
 *    the description *is* how a model decides whether to call something, so an
 *    operator writing "use this when you need facts you do not have; ask for a
 *    summary, not raw sources" is writing the only part of this feature that
 *    decides when it fires. Empty falls back to a sentence naming the agent.
 *  - **`permission` sits here rather than in `tools`.** The `tools` map is a list
 *    of installed tools, and a subagent is not one — putting `ask_researcher`
 *    there would render it in the editor's Tools section under a "not installed"
 *    badge, because it is absent from `/api/tools` and always will be.
 *
 * `allow` is the default because delegation is the feature: an agent given a
 * subagent is an agent whose operator wants it used. The tools the *subagent*
 * runs are gated by the subagent's own map, which is where the risk actually is.
 */
export const SubagentRefSchema = z.object({
  /** An id in `agents.list`. Checked against it by `assertBuildable`. */
  id: z.string(),
  /** The operator's guidance. Empty means the built-in sentence. */
  prompt: z.string().default(''),
  permission: ToolPermissionSchema.default('allow'),
});
export type SubagentRef = z.infer<typeof SubagentRefSchema>;

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
    /**
     * The per-iteration half's live-state section, as a template.
     *
     * Beside `systemPrompt` and for the same reason — an operator owns what their
     * agent is told — but with the opposite economics: this half is never cached,
     * so every line is re-sent on every request of every turn. Empty means the
     * built-in `DEFAULT_LIVE_STATE_TEMPLATE`. Its placeholder vocabulary is
     * `LIVE_PROMPT_PLACEHOLDERS`, which is *not* the identity half's: `{{time}}`
     * belongs only here, and `{{workspaceId}}` only there.
     *
     * Setting it to a single space is how an operator removes the section
     * entirely, since empty means "use the built-in".
     */
    livePrompt: z.string().default(''),
    /**
     * What is appended in the last few iterations of a turn.
     *
     * Separate from `livePrompt` because it is conditional and a placeholder
     * template cannot express a condition. Empty means the built-in
     * `DEFAULT_WRAP_UP_TEMPLATE`; a single space silences it.
     */
    wrapUpPrompt: z.string().default(''),
    /**
     * Whether `systemPrompt` is the static half or the entire system message.
     *
     * `template` — the default — leaves the four templates around it in force.
     * `raw` stops *placing* anything: no live-state block, no toolbox section, no
     * tool-output policy unless the template names `{{toolbox}}`, `{{toolPolicy}}`
     * and the rest.
     *
     * The three section templates below still decide what those placeholders
     * render *to*, so raw controls the layout rather than discarding the wording.
     * `livePrompt` is the exception and the only field raw ignores outright: its
     * entire content is `{{time}}{{wrapUp}}`, both of which a raw template names
     * directly.
     */
    promptMode: PromptModeSchema.default('template'),
    /**
     * The `## Running commands` section, as a template. Fills `{{platformPolicy}}`.
     *
     * Empty means the built-in for this agent's placement — `exec` on the host
     * and `exec` in a toolbox get different defaults, and which one applies is
     * decided by `toolbox.name` rather than by anything written here. A single
     * space removes the section.
     *
     * Editing it does not widen anything. Where a command may reach is decided by
     * `guardExec` and the workspace jail, neither of which reads the prompt; this
     * is the sentence that tells the model what those two will do.
     */
    platformPrompt: z.string().default(''),
    /**
     * The `## Toolbox: <name>` advertisement, as a template.
     *
     * Only rendered when the agent has a toolbox — an empty `toolbox.name`
     * produces no section whatever this says. Empty means the built-in; a single
     * space removes it, which is how an operator whose toolbox is described well
     * enough by its own `TOOLS.md` stops paying for the preamble twice.
     */
    toolboxPrompt: z.string().default(''),
    /**
     * The `## Tool output policy` section, as a template.
     *
     * Editable like the rest, and the one that deserves a sentence about what
     * that does and does not mean. The envelopes around tool results are emitted
     * by the runtime and the nonce is regenerated per turn whatever this says —
     * so this text is the *explanation* of a defence, not the defence. Deleting
     * it leaves the fences in place and the model with no reason to respect them,
     * which is why a template with no `{{nonce}}` and no `{{tag}}` saves with a
     * warning rather than silently.
     */
    toolPolicyPrompt: z.string().default(''),
    /**
     * Per-tool replacements for the description and the parameter descriptions
     * the model is sent.
     *
     * Keyed by advertised tool name, so it reaches built-ins, toolbox programs,
     * MCP and plugin tools and `ask_<id>` subagent tools alike. For a subagent
     * this wins over `subagents[].prompt`, being the more specific of the two.
     *
     * A key naming no advertised tool is a warning, not an error: a tool can
     * leave the list because a toolbox was uninstalled or `exec` was disabled,
     * and neither should stop an agent that was working a moment ago.
     */
    toolPrompts: ToolPromptOverridesSchema.default({}),
    enabled: z.boolean().default(true),
    /**
     * Replaces, never merges. An entry that names three tools has three tools —
     * the seed is what a *new* agent gets, not a floor every agent stands on,
     * or switching a tool off would be impossible to express.
     */
    tools: ToolPermissionsSchema.default({ ...DEFAULT_AGENT_TOOLS }),
    /** Merged over `tools.exec`, so one agent can hold a tighter allow-list. */
    exec: patchOf(ExecToolConfigSchema).optional(),
    toolbox: AgentToolboxSchema.prefault({}),
    memory: AgentMemoryScopeSchema.prefault({}),
    /**
     * Agents this one may delegate to. Order is the order the model sees them.
     *
     * A list rather than a record keyed by id because the order is the
     * operator's and a record has none — and because "the same agent twice" is
     * a mistake `assertBuildable` should name, not a shape the schema silently
     * collapses.
     */
    subagents: z.array(SubagentRefSchema).default([]),
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

/**
 * The engine, and nothing about any one job.
 *
 * Every key here is true of the *scheduler*; none of them describes a task.
 * That line is the whole shape of this block, and it is worth stating because
 * this schema used to break it: a `heartbeat` sub-block carried an
 * `intervalMin`, a `file`, a `model`, an `agentId`, a `sessionKey` and its own
 * `enabled`, which is a second way to describe one scheduled job — and the one
 * nothing read.
 *
 * A heartbeat **is** a job. Its interval is the job's schedule, its file and
 * model are the job's payload, and its on/off is the job's own flag. Two
 * vocabularies for one concept is how an operator configures the half that does
 * not run, so there is one: `AutomationJob`.
 */
export const SchedulerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Concurrent automation runs. Two keeps a slow job from blocking the queue. */
  concurrency: z.number().int().positive().default(2),
  /** Run `at` jobs whose time passed while the process was down. */
  catchUpOnBoot: z.boolean().default(true),
  /**
   * Runs kept per job, trimmed on write.
   *
   * Per job rather than a global cap: a nightly job's year of history must not
   * be evicted by a five-minute job's afternoon, which is exactly what one
   * shared ceiling would do. Unbounded is not an option — a job on a
   * five-minute interval writes about 105,000 rows a year.
   */
  runRetention: z.number().int().positive().default(200),
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

/**
 * What the install looks and reads like, for both surfaces.
 *
 * Its own section rather than a field on `server`, because nothing here is
 * transport: `server` is ports, hosts and auth, and a locale is neither. Theme
 * is the natural next occupant.
 *
 * `locale` is a bare `z.string()` on purpose. An enum would have to enumerate
 * the shipped languages, which would give `protocol` a dependency on
 * `@ghostai/i18n` for a value that changes every time a translation lands — and
 * would turn a config naming a language this build does not carry into a parse
 * failure that takes the whole file down. `resolveLocale` narrows an unknown tag
 * to the nearest match and ultimately to English, so an unrecognised value costs
 * a fallback rather than a broken install.
 *
 * `assertBootPolicy` reads only the `server` subtree, so nothing here is boot
 * policy — and `settings.reload` already exists, which is what makes a language
 * change take effect without a restart.
 */
export const UiConfigSchema = z.object({
  /** A BCP-47 tag. Unknown values fall back rather than failing to parse. */
  locale: z.string().default('en'),
  /**
   * The one zone this install reads and writes clock times in.
   *
   * Everything is *stored* in UTC — every persisted instant is epoch
   * milliseconds — so this is not a storage format. It is the answer to "whose
   * clock", and it is deliberately a single install-wide answer rather than one
   * per job: three timezone controls (a per-job zone, a scheduler default, and
   * whatever the viewer's browser happens to be set to) meant an operator had to
   * hold all three in their head to predict when a job fires.
   *
   * It governs both halves, and that is the point. A timestamp is *rendered* in
   * this zone, and a wall-clock time is *read* in it — so a cron written
   * `0 9 * * *` fires at 9am on the same clock the next-run line is printed
   * against, and nobody converts anything by hand.
   *
   * **A concrete IANA name, never a rule.** `system` is offered by the settings
   * select and resolved to a real zone before it is saved, exactly as the
   * language select resolves its own `system`. Storing the rule instead would
   * mean the server resolved it to the host zone while a browser resolved it to
   * the viewer's, which is the disagreement this field exists to end.
   *
   * **UTC rather than the host zone as the default**, and that is the point of
   * the default. A server's zone is a property of where it happens to be
   * running — it moves when the box moves, it is whatever the image was built
   * with, and on a laptop it follows the traveller. A schedule written
   * `0 9 * * *` would then fire at a different real instant after a migration
   * nobody connected to it. UTC is the one zone that does not drift, and an
   * operator who wants local time says so once, here.
   *
   * A bare `z.string()` for the reason `locale` is: an enum would have to
   * enumerate the IANA database, which changes without this schema. It is
   * validated where it is used — `parseCron` refuses a zone `Intl` does not
   * know, which surfaces as a 422 on the job that names it.
   */
  timezone: z.string().min(1).default('UTC'),
});
export type UiConfig = z.infer<typeof UiConfigSchema>;

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
  ui: UiConfigSchema.prefault({}),
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
      /**
       * Two fields accept `null`, and only two.
       *
       * `agents.defaults` is a struct that merges per field, so an absent key
       * means "not mentioned" and preserves what is there. That is right for
       * every field with a default — and wrong for the two that are genuinely
       * *optional*, because it left them impossible to clear: emptying the
       * temperature box produced a patch that simply did not mention it, and
       * the stored value survived a save that appeared to remove it.
       *
       * `null` is the one token the merge reads as a deletion (see
       * `DELETE_BY_NULL` in `@ghostai/runtime`). It is safe on exactly these
       * two because both are `.optional()` in `AgentDefaultsSchema`, so a
       * config with the key gone still re-parses. Doing the same to `model` or
       * `maxTokens` would punch a hole in the struct and fail that re-parse,
       * which is why this is a two-field exception rather than a rule.
       */
      defaults: patchOf(AgentDefaultsSchema)
        .extend({
          temperature: AgentDefaultsSchema.shape.temperature.nullable(),
          reasoningEffort: AgentDefaultsSchema.shape.reasoningEffort.nullable(),
        })
        .optional(),
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
              // Not a patch: the map replaces wholesale, because a patch that
              // merged key by key could add a tool and change a permission but
              // never remove one. `agents.list.*` is in the merge's
              // `REPLACE_WHOLESALE` list, so this is what already happens — it
              // is restated here so the type says it.
              tools: ToolPermissionsSchema.optional(),
              // `network` is restated because `patchOf` is not recursive, and
              // without it a save that only changes the mode would have to
              // resend `allow` — which is how a settings panel silently clears
              // the allow-list it never rendered.
              toolbox: patchOf(AgentToolboxSchema)
                .extend({
                  network: patchOf(AgentToolboxNetworkSchema).optional(),
                })
                .optional(),
              memory: patchOf(AgentMemoryScopeSchema).optional(),
              // `subagents` is deliberately *not* restated beside these. It is
              // an array, so it already replaces wholesale — there is no
              // per-field merge for `patchOf` to be non-recursive about, and
              // `patchOf` leaves the element schema's own defaults intact, so
              // `[{ id: 'researcher' }]` still arrives with a permission.
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
  providers: z
    .record(z.string(), patchOf(ProviderConfigSchema).nullable())
    .optional(),
  server: patchOf(ServerConfigSchema)
    .extend({ auth: patchOf(AuthConfigSchema).optional() })
    .optional(),
  tools: patchOf(ToolsConfigSchema)
    .extend({
      web: patchOf(WebToolsConfigSchema)
        .extend({ search: patchOf(WebSearchConfigSchema).optional() })
        .optional(),
      exec: patchOf(ExecToolConfigSchema).optional(),
      /**
       * `null` deletes the server, exactly as it does for a provider instance.
       *
       * Restated here for the same two reasons `providers` is: `patchOf` is not
       * recursive, so without this an entry would have to be resent whole to
       * change one field — and a record whose entries an operator adds and
       * removes needs a syntax for "remove this one". `mergeConfigPatch` has
       * listed `tools.mcpServers.*` in `DELETE_BY_NULL` since before there was
       * a client; until this line the null was rejected here, one layer above,
       * so that entry could never fire.
       */
      mcpServers: z
        .record(
          z.string(),
          patchOf(McpServerConfigSchema)
            .extend({
              /**
               * `null` says this server does not use OAuth.
               *
               * Needed because `oauth` is genuinely optional rather than
               * defaulted: "unset" is a real state, and an absent key already
               * means "not mentioned". The same reason
               * `agents.defaults.temperature` is in `DELETE_BY_NULL`.
               */
              oauth: McpOAuthConfigSchema.nullable().optional(),
            })
            .nullable(),
        )
        .optional(),
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
  scheduler: patchOf(SchedulerConfigSchema).optional(),
  plugins: patchOf(PluginsConfigSchema).optional(),
  ui: patchOf(UiConfigSchema).optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;
