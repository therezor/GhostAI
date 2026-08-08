import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { Clock, TimerHandle } from '@ghostbot/core';

import { defineTool, type AnyTool, type ToolContext } from '#src/define.js';
import { ToolRegistry } from '#src/registry.js';
import { createTestWorkspace, type TestWorkspace } from '#testkit/workspace.js';

/**
 * A clock whose timers only fire when a test says so.
 *
 * The registry's timeout is the one thing here that would otherwise make the
 * suite wait in real time, and a test that sleeps for a timeout is a test that
 * either takes seconds or is flaky on a loaded CI runner.
 */
interface ManualClock extends Clock {
  advance(ms: number): void;
}

function manualClock(): ManualClock {
  let monotonic = 0;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let nextId = 1;

  return {
    now: () => 1_700_000_000_000 + monotonic,
    monotonic: () => monotonic,
    setTimeout(callback, delayMs) {
      const id = nextId++;
      pending.set(id, { at: monotonic + delayMs, callback });
      return id as unknown as TimerHandle;
    },
    clearTimeout(handle) {
      pending.delete(handle as unknown as number);
    },
    sleep: async () => {
      await Promise.resolve();
    },
    advance(ms) {
      monotonic += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at > monotonic) continue;
        pending.delete(id);
        timer.callback();
      }
    },
  };
}

const echo = defineTool({
  name: 'echo',
  description: 'Echo a value back.',
  schema: z.strictObject({ text: z.string() }),
  execute: (args) => args.text,
});

const failing = defineTool({
  name: 'failing',
  description: 'Always throws.',
  schema: z.strictObject({}),
  execute: () => {
    throw new Error('boom');
  },
});

const flagged = defineTool({
  name: 'flagged',
  description: 'Reports a failure without throwing.',
  schema: z.strictObject({}),
  execute: () => ({
    content: 'Error: not found',
    isError: true,
    details: { code: 7 },
  }),
});

/**
 * A handler that never returns on its own.
 *
 * `deaf` is the case the race exists for: a tool that ignores its signal would
 * hang the turn forever if the registry only *signalled* the timeout instead of
 * racing it.
 */
function blocking(name: string, deaf: boolean): AnyTool {
  return defineTool({
    name,
    description: 'Blocks until aborted.',
    schema: z.strictObject({}),
    execute: async (args, context) =>
      await new Promise<string>((resolve, reject) => {
        if (deaf) return;
        context.signal.addEventListener(
          'abort',
          () => {
            reject(new Error('interrupted'));
          },
          { once: true },
        );
      }),
  });
}

let workspace: TestWorkspace;
let context: ToolContext;

beforeEach(() => {
  workspace = createTestWorkspace();
  context = workspace.context;
});

afterEach(() => {
  workspace.dispose();
});

describe('registration', () => {
  it('registers and looks up by name', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    expect(registry.has('echo')).toBe(true);
    expect(registry.get('echo')).toBe(echo);
    expect(registry.sourceOf('echo')).toBe('builtin');
    expect(registry.size).toBe(1);
  });

  it('refuses a duplicate name rather than overwriting', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    expect(() => {
      registry.register(echo, 'extension');
    }).toThrow(/already registered by builtin/);
    expect(registry.sourceOf('echo')).toBe('builtin');
  });

  it('rolls registerAll back when a name in the batch collides', () => {
    const registry = new ToolRegistry();
    registry.register(failing);
    expect(() => {
      registry.registerAll([echo, failing], 'extension');
    }).toThrow(/already registered/);
    // A half-installed extension is worse than one that failed to install.
    expect(registry.has('echo')).toBe(false);
    expect(registry.sourceOf('failing')).toBe('builtin');
  });

  it('removes exactly what one source registered', () => {
    const registry = new ToolRegistry();
    registry.register(echo, 'builtin');
    registry.register(failing, 'extension');
    registry.register(flagged, 'extension');
    expect(registry.unregisterBySource('extension')).toBe(2);
    expect(registry.names()).toEqual(['echo']);
    expect(registry.unregisterBySource('mcp')).toBe(0);
  });

  it('reports whether a single unregister did anything', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    expect(registry.unregister('echo')).toBe(true);
    expect(registry.unregister('echo')).toBe(false);
  });

  it('clears everything', () => {
    const registry = new ToolRegistry();
    registry.clear();
    registry.register(echo);
    registry.clear();
    expect(registry.size).toBe(0);
    expect(registry.definitions()).toEqual([]);
  });
});

describe('subscribe', () => {
  it('fires on every mutation and not on a no-op', () => {
    const registry = new ToolRegistry();
    let fired = 0;
    registry.subscribe(() => {
      fired += 1;
    });

    registry.register(echo);
    expect(fired).toBe(1);
    registry.register(failing, 'mcp');
    expect(fired).toBe(2);
    registry.unregisterBySource('mcp');
    expect(fired).toBe(3);
    // Nothing was registered by an extension, so nothing changed.
    registry.unregisterBySource('extension');
    expect(fired).toBe(3);
    registry.clear();
    expect(fired).toBe(4);
    // Already empty.
    registry.clear();
    expect(fired).toBe(4);
  });

  it('stops after the returned unsubscribe', () => {
    const registry = new ToolRegistry();
    let fired = 0;
    const release = registry.subscribe(() => {
      fired += 1;
    });
    registry.register(echo);
    release();
    registry.register(failing);
    expect(fired).toBe(1);
  });

  it('detaches a listener that throws rather than failing the registration', () => {
    const registry = new ToolRegistry();
    let good = 0;
    registry.subscribe(() => {
      throw new Error('the socket has gone away');
    });
    registry.subscribe(() => {
      good += 1;
    });

    // The registration itself must succeed: a dead transport is not a reason
    // for a tool to fail to register.
    expect(() => {
      registry.register(echo);
    }).not.toThrow();
    expect(registry.has('echo')).toBe(true);
    expect(good).toBe(1);

    registry.register(failing);
    // The thrower is gone; the healthy one is still there.
    expect(good).toBe(2);
  });
});

describe('definitions', () => {
  it('sorts by name so the cached prompt prefix is stable', () => {
    const registry = new ToolRegistry();
    registry.register(flagged);
    registry.register(echo);
    registry.register(failing);
    expect(registry.definitions().map((definition) => definition.name)).toEqual(
      ['echo', 'failing', 'flagged'],
    );
  });

  it('memoises until the registry changes', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const first = registry.definitions();
    expect(registry.definitions()).toBe(first);

    registry.register(failing, 'mcp');
    const second = registry.definitions();
    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);

    registry.unregisterBySource('mcp');
    expect(registry.definitions()).not.toBe(second);
  });

  it('does not invalidate the memo on a no-op mutation', () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const first = registry.definitions();
    expect(registry.unregister('absent')).toBe(false);
    expect(registry.unregisterBySource('extension')).toBe(0);
    expect(registry.definitions()).toBe(first);
  });

  it('carries the registration source of each tool', () => {
    const registry = new ToolRegistry();
    registry.register(echo, 'mcp');
    expect(registry.definitions()[0]?.source).toBe('mcp');
  });
});

describe('execute', () => {
  it('runs a tool and reports the result', async () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const execution = await registry.execute(
      { name: 'echo', argumentsJson: '{"text":"hello"}' },
      context,
    );
    expect(execution).toMatchObject({
      name: 'echo',
      content: 'hello',
      isError: false,
      truncated: false,
    });
    expect(execution.errorKind).toBeUndefined();
  });

  it('treats absent or empty arguments as an empty object', async () => {
    const registry = new ToolRegistry();
    registry.register(flagged);
    for (const argumentsJson of [undefined, '', '   ']) {
      const execution = await registry.execute(
        {
          name: 'flagged',
          ...(argumentsJson === undefined ? {} : { argumentsJson }),
        },
        context,
      );
      expect(execution.content).toBe('Error: not found');
    }
  });

  it('reports a flagged failure without treating the text as the signal', async () => {
    const registry = new ToolRegistry();
    registry.register(flagged);
    const execution = await registry.execute({ name: 'flagged' }, context);
    // The content starts with "Error", and that is not what made it a failure.
    expect(execution.isError).toBe(true);
    expect(execution.errorKind).toBeUndefined();
    expect(execution.details).toEqual({ code: 7 });
  });

  it('never throws for an unknown tool', async () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const execution = await registry.execute({ name: 'nope' }, context);
    expect(execution).toMatchObject({ isError: true, errorKind: 'not_found' });
    expect(execution.content).toContain('echo');
  });

  it('never throws on malformed argument JSON', async () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const execution = await registry.execute(
      { name: 'echo', argumentsJson: '{oops' },
      context,
    );
    expect(execution).toMatchObject({
      isError: true,
      errorKind: 'invalid_input',
    });
  });

  it('never throws on schema-invalid arguments', async () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const execution = await registry.execute(
      { name: 'echo', argumentsJson: '{"text":1}' },
      context,
    );
    expect(execution).toMatchObject({
      isError: true,
      errorKind: 'invalid_input',
    });
    expect(execution.details).toMatchObject({ tool: 'echo' });
  });

  it('never throws when the handler does', async () => {
    const registry = new ToolRegistry();
    registry.register(failing);
    const execution = await registry.execute({ name: 'failing' }, context);
    expect(execution).toMatchObject({
      isError: true,
      errorKind: 'tool',
      content: 'boom',
    });
  });

  it('truncates to the configured budget', async () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const long = 'x'.repeat(5_000);
    const execution = await registry.execute(
      { name: 'echo', argumentsJson: JSON.stringify({ text: long }) },
      workspace.with({ maxOutputChars: 100 }),
    );
    expect(execution.truncated).toBe(true);
    expect(execution.content).toContain('characters truncated');
    expect(execution.content.length).toBeLessThan(300);
  });

  it('refuses to enter a handler once the turn is aborted', async () => {
    const registry = new ToolRegistry();
    let entered = false;
    registry.register(
      defineTool({
        name: 'observer',
        description: 'Records whether it ran.',
        schema: z.strictObject({}),
        execute: () => {
          entered = true;
          return 'ran';
        },
      }),
    );
    workspace.controller.abort();
    const execution = await registry.execute({ name: 'observer' }, context);
    expect(entered).toBe(false);
    expect(execution).toMatchObject({ isError: true, errorKind: 'aborted' });
  });

  it('propagates the turn signal into the handler', async () => {
    const registry = new ToolRegistry();
    registry.register(blocking('waiting', false));
    const running = registry.execute({ name: 'waiting' }, context);
    workspace.controller.abort();
    await expect(running).resolves.toMatchObject({
      isError: true,
      errorKind: 'aborted',
    });
  });

  it('times a handler out on the injected clock', async () => {
    const clock = manualClock();
    const registry = new ToolRegistry({ timeoutMs: 30_000, clock });
    registry.register(blocking('deaf', true));

    const running = registry.execute({ name: 'deaf' }, context);
    await Promise.resolve();
    clock.advance(30_000);

    const execution = await running;
    expect(execution).toMatchObject({ isError: true, errorKind: 'timeout' });
    expect(execution.content).toContain('30000');
    expect(execution.durationMs).toBe(30_000);
  });

  it('takes a new timeout from a settings change', async () => {
    // Editable at runtime because the alternative — a new registry when
    // `toolTimeoutMs` changes — throws away every MCP and extension registration
    // on it, which is far more than the operator asked to change.
    const clock = manualClock();
    const registry = new ToolRegistry({ timeoutMs: 30_000, clock });
    registry.register(blocking('deaf', true));

    registry.timeoutMs = 1_000;
    const running = registry.execute({ name: 'deaf' }, context);
    await Promise.resolve();
    clock.advance(1_000);

    await expect(running).resolves.toMatchObject({
      isError: true,
      errorKind: 'timeout',
    });
  });

  it('refuses a timeout that is not a duration', () => {
    const registry = new ToolRegistry();
    expect(() => {
      registry.timeoutMs = -1;
    }).toThrow(/non-negative/);
    expect(() => {
      registry.timeoutMs = Number.NaN;
    }).toThrow(/non-negative/);
    expect(registry.timeoutMs).toBe(0);
  });

  it('reports an abort as aborted even when a timeout is configured', async () => {
    const clock = manualClock();
    const registry = new ToolRegistry({ timeoutMs: 30_000, clock });
    registry.register(blocking('deaf', true));

    const running = registry.execute({ name: 'deaf' }, context);
    await Promise.resolve();
    workspace.controller.abort();

    await expect(running).resolves.toMatchObject({ errorKind: 'aborted' });
  });

  it('does not leave a listener on the turn signal per call', async () => {
    const registry = new ToolRegistry();
    registry.register(echo);
    const added = vi.spyOn(workspace.controller.signal, 'addEventListener');
    const removed = vi.spyOn(
      workspace.controller.signal,
      'removeEventListener',
    );
    for (let index = 0; index < 5; index += 1) {
      await registry.execute(
        { name: 'echo', argumentsJson: '{"text":"x"}' },
        context,
      );
    }
    // `AbortSignal.any` adds one of its own per call; what matters is that the
    // count of removals keeps pace with the count of additions.
    expect(removed.mock.calls.length).toBeGreaterThanOrEqual(
      added.mock.calls.length,
    );
  });

  it('does not surface a late handler rejection as an unhandled rejection', async () => {
    const clock = manualClock();
    const registry = new ToolRegistry({ timeoutMs: 1_000, clock });
    let rejectLate: ((error: Error) => void) | undefined;
    registry.register(
      defineTool({
        name: 'late',
        description: 'Fails after the registry has given up.',
        schema: z.strictObject({}),
        execute: async () =>
          await new Promise<string>((resolve, reject) => {
            rejectLate = reject;
          }),
      }),
    );

    const running = registry.execute({ name: 'late' }, context);
    await Promise.resolve();
    clock.advance(1_000);
    await expect(running).resolves.toMatchObject({ errorKind: 'timeout' });

    rejectLate?.(new Error('too late'));
    // A tick for the rejection to be delivered; the `void .catch()` in the
    // registry is what keeps it from reaching the process handler.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
