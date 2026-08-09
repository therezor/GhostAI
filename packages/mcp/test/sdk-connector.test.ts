/**
 * The one suite that runs a real MCP client against a real MCP server.
 *
 * Everything else in this package speaks `McpSession`, which is what keeps the
 * suite fast and keeps a subprocess out of CI — but it also means nothing else
 * would notice if this adapter stopped speaking the protocol. `InMemoryTransport`
 * is how that gets checked without opening anything: two linked transports, the
 * SDK's own server on one end, and the same `Client` the real connector builds
 * on the other.
 */

import { silentLogger } from '@ghostwire/core';
import { McpServerConfigSchema } from '@ghostwire/protocol';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { sdkConnector } from '#src/sdk-connector.js';
import { resolveSpec, type McpConnectionSpec } from '#src/spec.js';

function spec(): McpConnectionSpec {
  const resolution = resolveSpec(
    'demo',
    McpServerConfigSchema.parse({ command: 'irrelevant' }),
  );
  if (!resolution.ok) throw resolution.error;
  return resolution.spec;
}

interface Wired {
  readonly server: McpServer;
  readonly transport: Transport;
}

/** A real `McpServer` on one end of a linked pair. */
function wire(): Wired {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = new McpServer(
    { name: 'demo-server', version: '2.1.0' },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.registerTool(
    'repeat',
    {
      description: 'Repeats a string.',
      inputSchema: { text: z.string().describe('The string to repeat.') },
    },
    ({ text }) => ({ content: [{ type: 'text', text }] }),
  );
  void server.connect(serverSide);
  return { server, transport: clientSide };
}

async function connect(wired: Wired) {
  const connector = sdkConnector({
    logger: silentLogger,
    transports: () => wired.transport,
  });
  return await connector(spec(), { signal: new AbortController().signal });
}

describe('sdkConnector', () => {
  it('completes the handshake and reports who answered', async () => {
    const wired = wire();
    const session = await connect(wired);

    expect(session.serverName).toBe('demo-server');
    expect(session.serverVersion).toBe('2.1.0');
    await session.close();
  });

  it('reads the advertised tools as descriptors the bridge understands', async () => {
    const wired = wire();
    const session = await connect(wired);

    const tools = await session.listTools(new AbortController().signal);
    expect(tools.map((tool) => tool.name)).toEqual(['repeat']);
    // The shape `normaliseSchema` is handed. If the SDK ever stopped supplying
    // raw JSON Schema here, every bridged tool would silently lose its
    // arguments, and this is the assertion that would say so.
    expect(tools[0]?.inputSchema).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' } },
    });
    await session.close();
  });

  it('calls a tool and returns its content parts', async () => {
    const wired = wire();
    const session = await connect(wired);

    const result = await session.callTool(
      'repeat',
      { text: 'hello' },
      { signal: new AbortController().signal, timeoutMs: 0 },
    );
    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    await session.close();
  });

  it('reports a tool that failed as a result, not a throw', async () => {
    const wired = wire();
    wired.server.registerTool(
      'explode',
      { description: 'Always fails.', inputSchema: {} },
      () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }),
    );
    const session = await connect(wired);

    const result = await session.callTool(
      'explode',
      {},
      { signal: new AbortController().signal, timeoutMs: 0 },
    );
    expect(result.isError).toBe(true);
    await session.close();
  });

  it('fires the tool-list listener when the server says the list moved', async () => {
    const wired = wire();
    const session = await connect(wired);
    let fired = 0;
    session.onToolListChanged(() => {
      fired += 1;
    });

    wired.server.registerTool(
      'reverse',
      { description: 'Reverses a string.', inputSchema: {} },
      () => ({ content: [] }),
    );

    // The SDK debounces before it re-lists, so this waits on the outcome
    // rather than on a fixed delay.
    await vi.waitFor(() => {
      expect(fired).toBeGreaterThan(0);
    });
    const tools = await session.listTools(new AbortController().signal);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'repeat',
      'reverse',
    ]);
    await session.close();
  });

  it('tells its listeners when the transport goes away', async () => {
    const wired = wire();
    const session = await connect(wired);
    let closed = false;
    session.onClose(() => {
      closed = true;
    });

    await wired.server.close();
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
  });

  it('does not report its own close as a drop', async () => {
    const wired = wire();
    const session = await connect(wired);
    let closed = false;
    session.onClose(() => {
      closed = true;
    });

    await session.close();
    // A connection told to shut down must not read its own teardown as a drop
    // and arm a reconnect.
    expect(closed).toBe(false);
  });

  it('reports a refused connection as a network error', async () => {
    const connector = sdkConnector({
      logger: silentLogger,
      transports: () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await expect(
      connector(spec(), { signal: new AbortController().signal }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });
});
