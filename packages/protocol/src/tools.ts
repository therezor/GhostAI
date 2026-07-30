/**
 * Tool wire shapes and the permission model.
 *
 * **A permission is per tool, and it is the only thing that decides.** An agent
 * carries a `name -> allow | ask | deny` map, and a name the map does not
 * mention is not enabled at all — so "which tools does this agent have" and
 * "what happens when it calls one" are one question with one answer, rather
 * than two mechanisms that can disagree.
 *
 * `risk` survives as **metadata**. It is declared by the tool, it rides on the
 * `tool.call` and `tool.approvalRequest` events so a card can badge itself, and
 * it seeds the permission a newly created agent starts a tool at. It decides
 * nothing at call time. It used to: a band-to-policy table in config was the
 * gate, which meant `search` and a port scanner in the same toolbox were one
 * setting, and an agent's tool list was a separate allow/deny pair that could
 * admit a tool the table then refused.
 */

import { z } from 'zod';

/**
 * What a tool can do, worst case. Bands rather than a boolean because the
 * useful default differs per band: reads are fine unattended, writes are
 * usually fine inside the workspace jail, exec and network are the two that a
 * self-hosted agent operator actually wants to see before they happen.
 *
 * Advisory since permissions became per tool — see the module header.
 */
export const ToolRiskSchema = z.enum(['safe', 'write', 'exec', 'network']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

export const TOOL_RISKS = ['safe', 'write', 'exec', 'network'] as const;

/**
 * What an agent may do with one tool.
 *
 * `deny` and *absent* mean the same thing to the runtime — the tool is not in
 * the definitions the model is sent. Both spellings exist because a UI needs
 * somewhere to put the off switch: an operator switching a tool off writes
 * `deny`, and that survives a round trip, where deleting the key would make the
 * row disappear from the editor entirely.
 */
export const ToolPermissionSchema = z.enum(['allow', 'ask', 'deny']);
export type ToolPermission = z.infer<typeof ToolPermissionSchema>;

/**
 * Tool name → permission.
 *
 * A record rather than a list of pairs so a patch that mentions one tool is one
 * key, and so the whole map replaces cleanly — removing a tool has to be
 * expressible, and a deep merge of two lists cannot express it.
 */
export const ToolPermissionsSchema = z.record(z.string(), ToolPermissionSchema);
export type ToolPermissions = z.infer<typeof ToolPermissionsSchema>;

/**
 * The tools that ship in the box.
 *
 * Here rather than in `@ghostai/tools`, which is where they are actually
 * defined, because two packages downstream need the *names* without the
 * implementations: `@ghostai/security` refuses a toolbox that shadows one, and
 * `DEFAULT_AGENT_TOOLS` in `config.ts` seeds a new agent with them. Both sit
 * below `tools` in the layer graph. `packages/tools` owns a test that this list
 * still matches `BUILTIN_TOOLS`, which is the only place both are visible.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'exec',
];

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
