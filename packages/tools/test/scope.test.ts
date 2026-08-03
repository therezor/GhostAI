import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool, type ToolContext } from '#src/define.js';
import { ToolRegistry } from '#src/registry.js';
import { isEnabled, permissionFor } from '#src/scope.js';
import { createTestWorkspace, type TestWorkspace } from '#testkit/workspace.js';

const tool = (name: string) =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    schema: z.strictObject({}),
    execute: () => name,
  });

/** Everything the fixture registry holds, at `allow`. */
const ALL = { read_file: 'allow', write_file: 'allow', exec: 'allow' } as const;

let workspace: TestWorkspace;
let context: ToolContext;
let registry: ToolRegistry;

beforeEach(() => {
  workspace = createTestWorkspace();
  context = workspace.context;
  registry = new ToolRegistry();
  registry.registerAll([tool('read_file'), tool('write_file'), tool('exec')]);
});

afterEach(() => {
  workspace.dispose();
});

describe('permissionFor', () => {
  it('reads back what the map says', () => {
    const perms = { read_file: 'allow', exec: 'ask', write_file: 'deny' } as const;

    expect(permissionFor(perms, 'read_file')).toBe('allow');
    expect(permissionFor(perms, 'exec')).toBe('ask');
    expect(permissionFor(perms, 'write_file')).toBe('deny');
  });

  it('denies a tool the map does not mention', () => {
    // The whole model: enabling is explicit, so silence is not consent. The
    // opposite of the allow/deny lists this replaced, where empty meant "all".
    expect(permissionFor({}, 'exec')).toBe('deny');
    expect(permissionFor({ read_file: 'allow' }, 'exec')).toBe('deny');
  });

  it('allows everything when there is no map at all', () => {
    // The bare registry — the CLI's one-shot paths and most tests. Not
    // reachable from a turn, which always resolves an agent first.
    expect(permissionFor(undefined, 'exec')).toBe('allow');
  });
});

describe('isEnabled', () => {
  it.each([
    ['allow', 'allow', true],
    ['ask', 'ask', true],
    ['deny', 'deny', false],
  ])('reports %s as %s', (_name, permission, expected) => {
    expect(isEnabled({ exec: permission as 'allow' }, 'exec')).toBe(expected);
  });

  it('treats absent exactly as deny', () => {
    expect(isEnabled({}, 'exec')).toBe(false);
  });
});

describe('ToolRegistry.select', () => {
  it('always returns a view, never the registry itself', () => {
    // There is no unrestricted agent any more: an empty map is an agent with
    // no tools, not one with all of them, so there is nothing to fast-path.
    expect(registry.select(ALL)).not.toBe(registry);
    expect(registry.select({})).not.toBe(registry);
  });

  it('offers nothing for an empty map', () => {
    expect(registry.select({}).definitions()).toEqual([]);
    expect(registry.definitions()).toHaveLength(3);
  });

  it('hides a denied tool from the definitions the model is offered', () => {
    const scope = registry.select({ ...ALL, exec: 'deny' });

    expect(scope.definitions().map((definition) => definition.name)).toEqual([
      'read_file',
      'write_file',
    ]);
    expect(registry.definitions()).toHaveLength(3);
  });

  it('offers a tool set to ask — asking is not hiding', () => {
    const scope = registry.select({ read_file: 'allow', exec: 'ask' });

    expect(scope.definitions().map((definition) => definition.name)).toEqual(['exec', 'read_file']);
    expect(scope.permissionFor('exec')).toBe('ask');
  });

  it('offers only what the map names', () => {
    const scope = registry.select({ read_file: 'allow' });

    expect(scope.definitions().map((definition) => definition.name)).toEqual(['read_file']);
  });

  it('keeps definitions sorted, so the cached prompt prefix is stable', () => {
    const scope = registry.select(ALL);
    const names = scope.definitions().map((definition) => definition.name);

    expect(names).toEqual([...names].sort());
  });

  it('reports a hidden tool as absent rather than as forbidden', () => {
    const scope = registry.select({ ...ALL, exec: 'deny' });

    expect(scope.get('exec')).toBeUndefined();
    expect(scope.get('read_file')?.name).toBe('read_file');
    // The registry still has it — this is a view, not a removal.
    expect(registry.get('exec')?.name).toBe('exec');
  });

  it('refuses to execute a hidden tool, without admitting it exists', async () => {
    const scope = registry.select({ ...ALL, exec: 'deny' });
    const result = await scope.execute({ name: 'exec' }, context);

    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe('not_found');
    // The suggestion lists what this agent can actually call.
    expect(result.content).toContain('read_file, write_file');
    expect(result.content).not.toMatch(/denied|forbidden|not allowed/i);
  });

  it('still executes a tool the map admits', async () => {
    const scope = registry.select({ read_file: 'allow' });
    const result = await scope.execute({ name: 'read_file' }, context);

    expect(result.isError).toBe(false);
    expect(result.content).toBe('read_file');
  });

  it('sees a tool registered after the scope was built', async () => {
    // A plugin loading at runtime must become visible to every agent whose
    // permissions admit it; a scope that snapshotted the list never would.
    const scope = registry.select({ ...ALL, exec: 'deny', list_dir: 'allow' });
    expect(scope.definitions()).toHaveLength(2);

    registry.register(tool('list_dir'), 'plugin');

    expect(scope.definitions().map((definition) => definition.name)).toEqual([
      'list_dir',
      'read_file',
      'write_file',
    ]);
    expect((await scope.execute({ name: 'list_dir' }, context)).isError).toBe(false);
  });

  it('does not admit a late-registered tool the agent never enabled', () => {
    // The reason absent means denied: a plugin cannot widen an agent by loading.
    const scope = registry.select({ ...ALL, exec: 'deny' });

    registry.register(tool('list_dir'), 'plugin');

    expect(scope.definitions().map((definition) => definition.name)).toEqual([
      'read_file',
      'write_file',
    ]);
  });

  it('drops a tool the registry unregisters', () => {
    const scope = registry.select({ ...ALL, exec: 'deny' });
    expect(scope.definitions()).toHaveLength(2);

    registry.unregister('write_file');

    expect(scope.definitions().map((definition) => definition.name)).toEqual(['read_file']);
  });

  it('reuses the memo while nothing has changed, and rebuilds when it does', () => {
    const scope = registry.select({ ...ALL, list_dir: 'allow' });

    const first = scope.definitions();
    expect(scope.definitions()).toBe(first);

    registry.register(tool('list_dir'));

    const second = scope.definitions();
    expect(second).not.toBe(first);
    expect(scope.definitions()).toBe(second);
  });

  it('gives two agents independent views of one registry', () => {
    const reviewer = registry.select({ read_file: 'allow' });
    const writer = registry.select({ ...ALL, exec: 'deny' });

    expect(reviewer.definitions()).toHaveLength(1);
    expect(writer.definitions()).toHaveLength(2);
    expect(registry.definitions()).toHaveLength(3);
  });

  it('answers allow for an unscoped registry', () => {
    expect(registry.permissionFor('exec')).toBe('allow');
  });
});
