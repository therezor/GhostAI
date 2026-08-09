/**
 * A bridged tool, put through the same suite every built-in holds.
 *
 * `toolConformance`'s own header says the contract covers a tool "built-in,
 * extension-supplied, or proxied from an MCP server", and this is the third of
 * those finally being checked. It is why `@ghostwire/tools` grew a `./testkit`
 * subpath: a contract only verifiable from inside the package that declares it
 * goes unverified exactly where it matters.
 *
 * **The fixture is a well-formed descriptor, deliberately.** The suite asserts
 * that every property carries a description and that unknown keys are refused,
 * and a real server is free to advertise neither. Those cases are covered in
 * `bridge.test.ts` and `schema.test.ts`, where the answer is "a warning, and
 * the tool still works" — which is a different claim from the one made here.
 * Pointing the conformance suite at a sloppy schema would only prove that the
 * schema is sloppy.
 */

import { createTestWorkspace, toolConformance } from '@ghostwire/tools/testkit';
import type { ToolContext } from '@ghostwire/tools';
import { afterAll } from 'vitest';

import { bridgeTool } from '#src/bridge.js';
import type { McpCallResult, McpToolDescriptor } from '#src/session.js';

/**
 * One string, one required, one integer with a minimum.
 *
 * Each earns its place: the string exercises the wrong-type refusal, the
 * integer exercises the `"10"` coercion models actually emit, and `required`
 * exercises the missing-argument case. `size` is what `largeOutputArgs` drives.
 */
const DESCRIPTOR: McpToolDescriptor = {
  name: 'repeat',
  description: 'Repeats a string, for as long as it is asked to.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The string to repeat.' },
      times: {
        type: 'integer',
        minimum: 1,
        description: 'How many times to repeat it.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
};

const bridged = bridgeTool({
  serverId: 'demo',
  descriptor: DESCRIPTOR,
  advertisedName: 'mcp_demo_repeat',
  toolTimeoutMs: 0,
  // The server, as a function. Nothing is spawned and nothing is dialled: the
  // suite is about the tool's edges, not about a transport.
  call: async (name, args): Promise<McpCallResult> => {
    const text = typeof args.text === 'string' ? args.text : '';
    const times = typeof args.times === 'number' ? args.times : 1;
    return await Promise.resolve({
      content: [{ type: 'text', text: text.repeat(times) }],
    });
  },
});

if (!('tool' in bridged)) {
  throw new Error('the conformance fixture failed to bridge');
}

const workspaces: Array<{ dispose(): void }> = [];

afterAll(() => {
  for (const workspace of workspaces) workspace.dispose();
});

toolConformance({
  tool: bridged.tool,
  context: (): ToolContext => {
    const workspace = createTestWorkspace();
    workspaces.push(workspace);
    return workspace.context;
  },
  validArgs: { text: 'hi', times: 2 },
  largeOutputArgs: { text: 'long-enough-line\n', times: 500 },
});
