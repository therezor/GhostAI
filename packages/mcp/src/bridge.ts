/**
 * A remote tool descriptor, as a `Tool` the registry can hold.
 *
 * The whole of the MCP-specific reasoning is in three decisions:
 *
 *  - **The `Tool` interface is implemented directly, not via `defineTool`.**
 *    See `schema.ts` for why the JSON Schema is not round-tripped through Zod.
 *  - **A band, when the server says nothing, is not `safe`.** An MCP server is
 *    third-party code reached over a socket. `readOnlyHint: true` is the server
 *    saying it only reads, and that is the one claim worth taking at face
 *    value; silence is not the same claim. Bands are advisory — nothing reads
 *    one at call time — so this only has to be honest.
 *  - **A remote failure is a result, never a throw.** `isError` on the wire
 *    becomes `isError` on the `ToolResult`, so the model reads what went wrong
 *    and adapts instead of the turn dying.
 *
 * What is *not* here, because it already happens elsewhere and would be wrong
 * to repeat: truncation and prompt-injection fencing. `ToolDispatcher` applies
 * `truncateHeadTail` then `wrapToolOutput` to every result, and the nonce
 * module's header names the MCP server as one of the parties whose output it is
 * fencing.
 */

import { GhostError } from '@ghostai/core';
import type { ToolDefinition, ToolRisk, ToolSource } from '@ghostai/protocol';
import {
  assertNotAborted,
  type AnyTool,
  type ToolResult,
} from '@ghostai/tools';

import {
  compileValidator,
  normaliseSchema,
  type SchemaIssue,
} from './schema.js';
import type {
  McpCallResult,
  McpContentPart,
  McpToolDescriptor,
} from './session.js';

/** Placeholder for a part the model cannot read. See `flattenContent`. */
const BINARY_PLACEHOLDER_TYPES = new Set(['image', 'audio']);

export interface BridgeOptions {
  readonly serverId: string;
  readonly descriptor: McpToolDescriptor;
  /** Already flattened and deduplicated by `names.ts`. */
  readonly advertisedName: string;
  readonly toolTimeoutMs: number;
  readonly call: (
    upstreamName: string,
    args: Record<string, unknown>,
    options: { readonly signal: AbortSignal; readonly timeoutMs: number },
  ) => Promise<McpCallResult>;
}

export interface BridgedTool {
  readonly tool: AnyTool;
  readonly upstreamName: string;
  readonly issues: readonly SchemaIssue[];
}

/**
 * What band a tool gets, from what the server was willing to claim.
 *
 * `destructiveHint` is the server volunteering that a call is not undoable, so
 * it earns the band an operator most wants to see before it happens. Everything
 * else that is not explicitly read-only is `network`, which is true of every
 * MCP call by construction.
 */
function riskOf(descriptor: McpToolDescriptor): ToolRisk {
  const annotations = descriptor.annotations;
  if (annotations?.readOnlyHint === true) return 'safe';
  if (annotations?.destructiveHint === true) return 'exec';
  return 'network';
}

/**
 * The sentence that decides whether the model reaches for this tool.
 *
 * A description is required of every tool in this repo, and a server is allowed
 * to omit one — so there is a fallback, and it says the two things a model can
 * still act on: what the tool is called upstream, and whose it is.
 */
function describe(descriptor: McpToolDescriptor, serverId: string): string {
  const own = descriptor.description?.trim();
  if (own !== undefined && own !== '') return own;
  const title = descriptor.title?.trim();
  if (title !== undefined && title !== '') return title;
  return `${descriptor.name}, from the ${serverId} MCP server.`;
}

function describeBinary(part: McpContentPart): string {
  const bytes =
    part.data === undefined ? 0 : Math.floor((part.data.length * 3) / 4);
  const type = part.mimeType ?? part.type;
  return `[${type}, ${String(bytes)} bytes — not shown]`;
}

/**
 * Every part of a result as one string.
 *
 * Binary parts become a placeholder rather than their base64: a model reading
 * a megabyte of base64 learns nothing from it and the bytes would consume the
 * whole of `maxOutputChars`, evicting the text parts that do say something.
 */
export function flattenContent(result: McpCallResult): string {
  const parts = result.content ?? [];
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      lines.push(part.text ?? '');
      continue;
    }
    if (BINARY_PLACEHOLDER_TYPES.has(part.type)) {
      lines.push(describeBinary(part));
      continue;
    }
    if (part.type === 'resource') {
      const embedded = part.resource;
      lines.push(embedded?.text ?? embedded?.uri ?? '[resource — not shown]');
      continue;
    }
    if (part.type === 'resource_link') {
      lines.push(part.uri ?? '[resource link]');
      continue;
    }
    lines.push(`[${part.type} — not shown]`);
  }
  if (lines.length > 0) return lines.join('\n');
  // A server answering with structured output and no content blocks is legal.
  // Showing the model nothing at all would look like a tool that silently did
  // nothing, which is the one outcome it cannot recover from.
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  return '';
}

/**
 * One descriptor as a tool, or the reason it cannot be one.
 *
 * A schema this client cannot advertise drops that tool and leaves the rest of
 * the server working — the alternative, refusing the whole server because one
 * of its forty tools has a malformed schema, is a worse trade in every case.
 */
export function bridgeTool(
  options: BridgeOptions,
): BridgedTool | { readonly issues: readonly SchemaIssue[] } {
  const { descriptor, serverId, advertisedName } = options;

  let normalised;
  try {
    normalised = normaliseSchema(descriptor.name, descriptor.inputSchema);
  } catch (error) {
    return {
      issues: [
        {
          tool: descriptor.name,
          message:
            error instanceof Error
              ? error.message
              : 'advertises a schema this client cannot read',
        },
      ],
    };
  }

  const { parameters } = normalised;
  const description = describe(descriptor, serverId);
  const risk = riskOf(descriptor);
  const annotations = descriptor.annotations;
  const parseArgs = compileValidator(advertisedName, parameters);

  const execute = async (
    args: Record<string, unknown>,
    context: { readonly signal: AbortSignal },
  ): Promise<ToolResult> => {
    assertNotAborted(context.signal, advertisedName);
    const result = await options.call(descriptor.name, args, {
      signal: context.signal,
      timeoutMs: options.toolTimeoutMs,
    });
    return {
      content: flattenContent(result),
      isError: result.isError === true,
      // Audit context, never shown to the model — which is the right home for
      // `structuredContent`: it is the machine-readable twin of the text above
      // and duplicating it into the prompt would double the cost of every call.
      ...(result.structuredContent === undefined
        ? {}
        : { details: { structuredContent: result.structuredContent } }),
    };
  };

  const tool: AnyTool = {
    name: advertisedName,
    description,
    risk,
    annotations,
    parameters,
    parseArgs,
    execute: async (args, context) =>
      await execute(args as Record<string, unknown>, context),
    async run(raw, context) {
      // Before validation, so a turn cancelled while this call was queued
      // unwinds as a cancellation rather than as an argument error.
      assertNotAborted(context.signal, advertisedName);
      const parsed = parseArgs(raw);
      if (!parsed.ok) {
        throw new GhostError('invalid_input', parsed.message, {
          details: { tool: advertisedName, issues: parsed.issues },
        });
      }
      return await execute(parsed.args, context);
    },
    definition(source: ToolSource = 'mcp'): ToolDefinition {
      return {
        name: advertisedName,
        description,
        parameters,
        risk,
        source,
        ...(annotations === undefined ? {} : { annotations }),
      };
    },
  };

  return { tool, upstreamName: descriptor.name, issues: normalised.issues };
}
