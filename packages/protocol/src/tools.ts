/**
 * Tool wire shapes and the approval model.
 *
 * `risk` is declared by the tool at definition time; the policy mapping a risk
 * band to `ask` / `allow` / `deny` lives in config. Splitting it that way makes
 * the gate a property of the deployment rather than of the calling code, so no
 * call site can forget to check.
 */

import { z } from 'zod';

/**
 * What a tool can do, worst case. Bands rather than a boolean because the
 * useful default differs per band: reads are fine unattended, writes are
 * usually fine inside the workspace jail, exec and network are the two that a
 * self-hosted agent operator actually wants to see before they happen.
 */
export const ToolRiskSchema = z.enum(['safe', 'write', 'exec', 'network']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const TOOL_RISKS = ['safe', 'write', 'exec', 'network'] as const;

export const ToolApprovalPolicySchema = z.enum(['allow', 'ask', 'deny']);
export type ToolApprovalPolicy = z.infer<typeof ToolApprovalPolicySchema>;

/** Where a registered tool came from, so `unregisterBySource` can be exact. */
export const ToolSourceSchema = z.enum(['builtin', 'mcp', 'plugin']);
export type ToolSource = z.infer<typeof ToolSourceSchema>;

/**
 * Hints about a tool's effects, mirroring MCP's annotation vocabulary so
 * built-in tools and tools proxied from an MCP server describe themselves the
 * same way.
 */
export const ToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

/**
 * A tool as advertised to a model or listed over REST.
 *
 * `parameters` is an already-computed JSON Schema object (from
 * `z.toJSONSchema`), kept opaque here: validating a JSON Schema *document*
 * against Zod would buy nothing, and the value is produced by this repo rather
 * than accepted from a client.
 */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  risk: ToolRiskSchema.default('safe'),
  source: ToolSourceSchema.default('builtin'),
  annotations: ToolAnnotationsSchema.optional(),
});
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * How long an approval decision holds.
 *
 * `session` is what makes the prompt tolerable in practice — approving `exec`
 * once per session rather than once per call.
 */
export const ApprovalScopeSchema = z.enum(['once', 'session', 'always']);
export type ApprovalScope = z.infer<typeof ApprovalScopeSchema>;
