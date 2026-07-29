import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { defineTool, type ToolContext } from './define.js';
import { ToolRegistry } from './registry.js';
import { isUnrestricted, selectionAllows } from './scope.js';
import { createTestWorkspace, type TestWorkspace } from './testkit/workspace.js';

const tool = (name: string) =>
  defineTool({
    name,
    description: `The ${name} tool.`,
    schema: z.strictObject({}),
    execute: () => name,
  });

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

describe('selectionAllows', () => {
  it('lets everything through when there is no selection at all', () => {
    expect(selectionAllows(undefined, 'exec')).toBe(true);
    expect(selectionAllows({}, 'exec')).toBe(true);
  });

  it('treats an empty allow-list as "everything not denied"', () => {
    // The same reading as ExecToolConfig.allowedBinaries. Empty meaning
    // "nothing" would make a freshly created agent look broken.
    expect(selectionAllows({ allow: [] }, 'exec')).toBe(true);
    expect(selectionAllows({ allow: [], deny: ['exec'] }, 'exec')).toBe(false);
  });

  it('admits only the allow-list once it has an entry', () => {
    expect(selectionAllows({ allow: ['read_file'] }, 'read_file')).toBe(true);
    expect(selectionAllows({ allow: ['read_file'] }, 'exec')).toBe(false);
  });

  it('lets deny beat allow', () => {
    // Otherwise switching a tool off for an agent could be undone by a blanket
    // allow-list in the same object, and which wins would be unpredictable.
    expect(selectionAllows({ allow: ['exec'], deny: ['exec'] }, 'exec')).toBe(false);
  });
});

describe('isUnrestricted', () => {
  it.each([
    ['undefined', undefined, true],
    ['empty', {}, true],
    ['both lists empty', { allow: [], deny: [] }, true],
    ['a deny entry', { deny: ['exec'] }, false],
    ['an allow entry', { allow: ['read_file'] }, false],
  ])('reports %s as %s', (_name, selection, expected) => {
    expect(isUnrestricted(selection)).toBe(expected);
  });
});

describe('ToolRegistry.select', () => {
  it('hands back the registry itself when nothing is restricted', () => {
    // The common case — an agent with no tool list — pays for no wrapper.
    expect(registry.select(undefined)).toBe(registry);
    expect(registry.select({ allow: [], deny: [] })).toBe(registry);
  });

  it('hides a denied tool from the definitions the model is offered', () => {
    const scope = registry.select({ deny: ['exec'] });

    expect(scope.definitions().map((definition) => definition.name)).toEqual([
      'read_file',
      'write_file',
    ]);
    expect(registry.definitions()).toHaveLength(3);
  });

  it('offers only the allow-list when one is given', () => {
    const scope = registry.select({ allow: ['read_file'] });

    expect(scope.definitions().map((definition) => definition.name)).toEqual(['read_file']);
  });

  it('keeps definitions sorted, so the cached prompt prefix is stable', () => {
    const scope = registry.select({ deny: ['nothing-by-this-name'] });
    const names = scope.definitions().map((definition) => definition.name);

    expect(names).toEqual([...names].sort());
  });

  it('reports a hidden tool as absent rather than as forbidden', () => {
    const scope = registry.select({ deny: ['exec'] });

    expect(scope.get('exec')).toBeUndefined();
    expect(scope.get('read_file')?.name).toBe('read_file');
    // The registry still has it — this is a view, not a removal.
    expect(registry.get('exec')?.name).toBe('exec');
  });

  it('refuses to execute a hidden tool, without admitting it exists', async () => {
    const scope = registry.select({ deny: ['exec'] });
    const result = await scope.execute({ name: 'exec' }, context);

    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe('not_found');
    // The suggestion lists what this agent can actually call.
    expect(result.content).toContain('read_file, write_file');
    expect(result.content).not.toMatch(/denied|forbidden|not allowed/i);
  });

  it('still executes a tool the selection admits', async () => {
    const scope = registry.select({ allow: ['read_file'] });
    const result = await scope.execute({ name: 'read_file' }, context);

    expect(result.isError).toBe(false);
    expect(result.content).toBe('read_file');
  });

  it('sees a tool registered after the scope was built', async () => {
    // A plugin loading at runtime must become visible to every agent whose
    // selection admits it; a scope that snapshotted the list never would.
    const scope = registry.select({ deny: ['exec'] });
    expect(scope.definitions()).toHaveLength(2);

    registry.register(tool('list_dir'), 'plugin');

    expect(scope.definitions().map((definition) => definition.name)).toEqual([
      'list_dir',
      'read_file',
      'write_file',
    ]);
    expect((await scope.execute({ name: 'list_dir' }, context)).isError).toBe(false);
  });

  it('drops a tool the registry unregisters', () => {
    const scope = registry.select({ deny: ['exec'] });
    expect(scope.definitions()).toHaveLength(2);

    registry.unregister('write_file');

    expect(scope.definitions().map((definition) => definition.name)).toEqual(['read_file']);
  });

  it('reuses the memo while nothing has changed, and rebuilds when it does', () => {
    const scope = registry.select({ deny: ['exec'] });

    const first = scope.definitions();
    expect(scope.definitions()).toBe(first);

    registry.register(tool('list_dir'));

    const second = scope.definitions();
    expect(second).not.toBe(first);
    expect(scope.definitions()).toBe(second);
  });

  it('gives two agents independent views of one registry', () => {
    const reviewer = registry.select({ allow: ['read_file'] });
    const writer = registry.select({ deny: ['exec'] });

    expect(reviewer.definitions()).toHaveLength(1);
    expect(writer.definitions()).toHaveLength(2);
    expect(registry.definitions()).toHaveLength(3);
  });
});
