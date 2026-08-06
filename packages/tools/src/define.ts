/**
 * `defineTool` — the single declaration a tool needs.
 *
 * The Python source this replaces hand-rolled ~200 lines of JSON-Schema casting
 * (`tools/base.py:70-212`): a schema written once as a dict, a parallel set of
 * `isinstance` checks, and a third copy of the shape in the handler signature.
 * Three copies of one truth drift, and the drift shows up as a provider 400 or
 * a `TypeError` inside a tool. Here the Zod schema is the only copy: the JSON
 * Schema advertised to the model is derived from it, validation is `safeParse`
 * against it, and the handler's argument type is inferred from it, so a schema
 * change that the handler does not follow is a compile error.
 *
 * Three decisions are load-bearing:
 *
 *  - **`io: 'input'`.** `z.toJSONSchema` defaults to the *output* view, in which
 *    a field carrying `.default()` is `required` — it is always present once
 *    parsing has run. Advertising that view tells the model it must supply every
 *    optional argument, which is both wrong and a reliable source of invented
 *    values. The input view is what the model is actually being asked for.
 *
 *  - **The schema must be a `strictObject`.** Rejecting unknown keys is not
 *    pedantry: a model that adds `recursive: true` to `read_file` has
 *    misunderstood the tool, and silently stripping the key runs a command it
 *    did not ask for and returns an answer to a question it did not pose. The
 *    check is on the emitted `additionalProperties`, so it holds however the
 *    schema was built.
 *
 *  - **`z.coerce` on numbers, deliberately.** Models emit `"10"` for a number
 *    argument often enough that refusing it is a self-inflicted failure mode;
 *    the coercion belongs in the schema, where it is declared once, rather than
 *    in every handler.
 *
 * Note the exported built-ins are annotated `AnyTool` rather than their inferred
 * type. `isolatedDeclarations` cannot emit a declaration for an inference
 * result, and the alternative — hand-writing an interface beside every schema —
 * is exactly the second copy this module exists to remove. Inference still
 * applies where it earns its keep: inside `execute`, whose argument type comes
 * from the schema at the call site.
 */

import { z } from 'zod';

import { GhostError, abortedError } from '@ghostai/core';
import type { Clock, Logger } from '@ghostai/core';
import type {
  ToolAnnotations,
  ToolDefinition,
  ToolRisk,
  ToolSource,
  ToolsConfig,
} from '@ghostai/protocol';
import { ToolsConfigSchema } from '@ghostai/protocol';
import type { WorkspaceJail } from '@ghostai/security';

import type { AutomationPort } from './automation.js';
import type { CommandRunner } from './runner.js';

/**
 * The name shape every provider accepts.
 *
 * OpenAI, and every gateway speaking its wire, restricts function names to this
 * set. A tool named `web search` is not rejected at registration by the provider
 * — it is rejected mid-turn, as a 400 that reads like the model is broken. The
 * MCP flattening (`mcp_{server}_{tool}`) exists partly to keep remote names
 * inside it.
 */
export const TOOL_NAME_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,64}$/;

/** Config as the schema defines it, for tests and for a caller with no file. */
export const DEFAULT_TOOLS_CONFIG: ToolsConfig = ToolsConfigSchema.parse({});

/**
 * Everything a tool may reach, supplied per call rather than captured at
 * definition time.
 *
 * A tool is a value, not a closure over a workspace: the registry is built once
 * and the same `read_file` serves every session, so the jail, the config and —
 * critically — the turn's `AbortSignal` arrive with the invocation. Capturing
 * them would mean a registry per session and a signal that is one turn stale.
 */
export interface ToolContext {
  /** The only thing permitted to judge an agent-supplied path. */
  readonly jail: WorkspaceJail;
  /**
   * The turn's signal, already combined with any per-call timeout by the
   * registry. Every tool must observe it before doing work and while doing it.
   */
  readonly signal: AbortSignal;
  readonly config: ToolsConfig;
  readonly clock?: Clock;
  readonly logger?: Logger;
  /** Source for the exec env allow-list. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Where a guarded command runs. Defaults to `localRunner` — a child process
   * on this machine, which is what `exec` has always done.
   *
   * Optional so that nothing constructing a context has to know about it, and
   * the seam an agent's `sandbox` setting reaches the tool layer through.
   */
  readonly runner?: CommandRunner;
  /**
   * Whether `runner` confines the command to a container mounting only the
   * workspace.
   *
   * Separate from `runner` being set, because the two answer different
   * questions: `runner` is *where*, and this is *whether the guard's
   * host-shaped assumptions still hold*. A future runner that ran commands on
   * another host without confining them would set one and not the other.
   */
  readonly sandboxed?: boolean;
  /**
   * Where a scheduled job gets written, already scoped to this turn's agent and
   * session.
   *
   * Optional and resolved per turn for the same reasons as `runner`: nothing
   * constructing a context has to know about it, and a build with no scheduler
   * simply leaves it out — the tool then refuses rather than pretending.
   */
  readonly automation?: AutomationPort;
}

/**
 * What a handler returns.
 *
 * `isError` is a flag rather than a prefix on the text. A tool whose legitimate
 * output starts with the word "Error" — `grep` over a log file, say — must not
 * be recorded as a failed call, which is precisely the bug the Python registry's
 * `result.startswith("Error")` check produced.
 */
export interface ToolResult {
  readonly content: string;
  readonly isError?: boolean;
  /** Structured context for the audit log. Never shown to the model. */
  readonly details?: Readonly<Record<string, unknown>>;
}

type ToolOutput = string | ToolResult;

export interface ArgIssue {
  /** Dotted path to the offending property, or `''` for the object itself. */
  readonly path: string;
  readonly message: string;
}

export type ParseArgsResult<Args> =
  | { readonly ok: true; readonly args: Args }
  | {
      readonly ok: false;
      readonly message: string;
      readonly issues: readonly ArgIssue[];
    };

interface ToolSpec<S extends z.ZodType> {
  readonly name: string;
  readonly description: string;
  /** Must be a `z.strictObject`. See the module header. */
  readonly schema: S;
  /** Defaults to `safe`; the approval policy per band lives in config. */
  readonly risk?: ToolRisk;
  readonly annotations?: ToolAnnotations;
  execute(
    args: z.output<S>,
    context: ToolContext,
  ): Promise<ToolOutput> | ToolOutput;
}

/**
 * A defined tool.
 *
 * The `Args` parameter is erased to `unknown` wherever tools are stored
 * together (`AnyTool`); `execute` is declared with method syntax so that
 * erasure is assignable. The typed form is what the handler body sees.
 */
export interface Tool<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  readonly annotations: ToolAnnotations | undefined;
  /** JSON Schema, computed once at definition time and frozen. */
  readonly parameters: Readonly<Record<string, unknown>>;
  parseArgs(raw: unknown): ParseArgsResult<Args>;
  execute(args: Args, context: ToolContext): Promise<ToolOutput>;
  /** Validate then execute. Throws `invalid_input` if validation fails. */
  run(raw: unknown, context: ToolContext): Promise<ToolOutput>;
  definition(source?: ToolSource): ToolDefinition;
}

/** A tool with its argument type erased, for storage and iteration. */
export type AnyTool = Tool;

/** Throws the taxonomy's `aborted` rather than a bare `DOMException`. */
export function assertNotAborted(signal: AbortSignal, what: string): void {
  if (signal.aborted) throw abortedError(what);
}

/** Normalises a `ToolResult | string` into the object form. */
export function toToolResult(output: ToolOutput): ToolResult {
  return typeof output === 'string' ? { content: output } : output;
}

function describeIssues(error: z.ZodError): readonly ArgIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function computeParameters(
  name: string,
  schema: z.ZodType,
): Readonly<Record<string, unknown>> {
  let emitted: Record<string, unknown>;
  try {
    emitted = z.toJSONSchema(schema, { io: 'input' });
  } catch (error) {
    throw new GhostError(
      'config',
      `Tool ${name} has a schema with no JSON Schema form`,
      {
        cause: error,
        details: { tool: name },
      },
    );
  }

  // `$schema` is a document-level annotation. Providers accept the object as a
  // parameter schema, not as a standalone document, and some gateways reject
  // unknown top-level keys outright.
  const { $schema: document, ...parameters } = emitted;

  if (parameters.type !== 'object') {
    throw new GhostError(
      'config',
      `Tool ${name} must take an object, not ${String(parameters.type)}`,
      {
        details: { tool: name },
      },
    );
  }
  if (parameters.additionalProperties !== false) {
    throw new GhostError(
      'config',
      `Tool ${name} must use z.strictObject so unknown arguments are rejected rather than stripped`,
      { details: { tool: name } },
    );
  }
  return Object.freeze(parameters);
}

/**
 * Defines a tool from a Zod schema and a handler.
 *
 * Everything derivable is derived here and once: a tool defined at module load
 * computes its JSON Schema at module load, not per turn and not per iteration.
 */
export function defineTool<S extends z.ZodType>(
  spec: ToolSpec<S>,
): Tool<z.output<S>> {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new GhostError(
      'config',
      `Tool name must match ${TOOL_NAME_PATTERN.source}: ${spec.name}`,
      { details: { tool: spec.name } },
    );
  }
  if (spec.description.trim() === '') {
    throw new GhostError('config', `Tool ${spec.name} has no description`, {
      details: { tool: spec.name },
    });
  }

  const parameters = computeParameters(spec.name, spec.schema);
  const risk: ToolRisk = spec.risk ?? 'safe';
  const annotations = spec.annotations;

  const parseArgs = (raw: unknown): ParseArgsResult<z.output<S>> => {
    // A model calling a no-argument tool commonly emits `""`, `"{}"` or nothing
    // at all; the provider adapters hand that through as `undefined`. Treating
    // it as an empty object lets the schema's own `required` list decide,
    // instead of failing every such call with "expected object, received
    // undefined".
    const candidate = raw ?? {};
    const result = spec.schema.safeParse(candidate);
    if (result.success) return { ok: true, args: result.data };
    const issues = describeIssues(result.error);
    const detail = issues
      .map((issue) =>
        issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`,
      )
      .join('; ');
    return {
      ok: false,
      message: `Invalid arguments for ${spec.name}: ${detail}`,
      issues,
    };
  };

  const execute = async (
    args: z.output<S>,
    context: ToolContext,
  ): Promise<ToolOutput> => await spec.execute(args, context);

  return {
    name: spec.name,
    description: spec.description,
    risk,
    annotations,
    parameters,
    parseArgs,
    execute,
    async run(raw, context) {
      const parsed = parseArgs(raw);
      if (!parsed.ok) {
        throw new GhostError('invalid_input', parsed.message, {
          details: { tool: spec.name, issues: parsed.issues },
        });
      }
      return await execute(parsed.args, context);
    },
    definition(source: ToolSource = 'builtin'): ToolDefinition {
      return {
        name: spec.name,
        description: spec.description,
        parameters,
        risk,
        source,
        ...(annotations === undefined ? {} : { annotations }),
      };
    },
  };
}
