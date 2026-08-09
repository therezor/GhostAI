import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ToolboxSchema, type Toolbox } from '@ghostwire/protocol';
import { WorkspaceJail } from '@ghostwire/security';

import { DEFAULT_TOOLS_CONFIG, type ToolContext } from '#src/define.js';
import { ToolRegistry, withToolboxTools } from '#src/registry.js';
import {
  toolboxPermissions,
  toolboxTool,
  toolboxTools,
  visibleToolboxEntries,
} from '#src/toolbox-tools.js';
import { registerBuiltins } from '#src/builtin/index.js';
import type { CommandRunner } from '#src/runner.js';

const DIGEST = `sha256:${'e'.repeat(64)}`;

function toolboxOf(overrides: Record<string, unknown> = {}): Toolbox {
  return ToolboxSchema.parse({
    schema: 'ghostai.toolbox/1',
    name: 'web-research',
    image: DIGEST,
    tools: [
      {
        name: 'ddgr',
        use: 'Search the web.',
        args: '--json is required; the plain form is a pager and hangs.',
        example: ['--json', '-n', '3', 'sqlite wal mode'],
        requiresArgs: true,
      },
      { name: 'fetch', use: 'Read a web page as text.', requiresArgs: true },
    ],
    ...overrides,
  });
}

describe('toolboxTools', () => {
  it('exposes nothing by default, because prose is the cheap answer', () => {
    // Forty tokens for a box of two hundred programs. Materialising schemas is
    // the opt-in, not the default.
    expect(toolboxTools(toolboxOf())).toEqual([]);
  });

  it('materialises one callable per declared entry when asked', () => {
    const tools = toolboxTools(toolboxOf({ expose: 'tools' }));

    expect(tools.map((tool) => tool.name)).toEqual(['ddgr', 'fetch']);
  });

  it('carries the declared use into the description the model reads', () => {
    const [ddgr] = toolboxTools(toolboxOf({ expose: 'tools' }));

    expect(ddgr?.description).toBe('Search the web.');
    // The toolbox is named once in the prompt section, not eight times here.
    expect(ddgr?.description).not.toContain('web-research');
  });

  it('puts the argument guidance and a copyable example on the args field', () => {
    // Where the model is actually looking while it decides what to send. A
    // generic "arguments as separate strings" says nothing about the flag this
    // program insists on.
    const [ddgr] = toolboxTools(toolboxOf({ expose: 'tools' }));
    const described = (
      ddgr?.parameters as { properties: { args: { description: string } } }
    ).properties.args.description;

    expect(described).toContain('--json is required');
    expect(described).toContain('["--json","-n","3","sqlite wal mode"]');
    expect(described).toContain('do not repeat it');
  });

  it('refuses an empty call for a program that needs an argument', () => {
    // Observed: a model called `fetch` with no URL, got a usage error from the
    // program, and gave up. A validation message it can act on is the difference.
    const [, fetch] = toolboxTools(toolboxOf({ expose: 'tools' }));

    expect(fetch?.parseArgs({ args: [] }).ok).toBe(false);
    expect(fetch?.parseArgs({ args: ['https://example.com'] }).ok).toBe(true);
  });

  it('still accepts an empty array for a program that takes none', () => {
    const tools = toolboxTools(
      toolboxOf({
        expose: 'tools',
        tools: [{ name: 'uptime', use: 'Show load.' }],
      }),
    );

    expect(tools[0]?.parseArgs({ args: [] }).ok).toBe(true);
  });

  it('runs at the exec risk band, because it is exec', () => {
    // A gentler band would be an approval an operator configured and then
    // silently stopped being asked for.
    expect(toolboxTools(toolboxOf({ expose: 'tools' }))[0]?.risk).toBe('exec');
  });

  it('drops an entry no provider would accept as a function name', () => {
    // A manifest is data. `foo bar` would be a mid-turn 400 that reads like the
    // model is broken, so it never reaches the wire.
    const tools = toolboxTools(
      toolboxOf({
        expose: 'tools',
        tools: [{ name: 'foo bar' }, { name: 'ok' }],
      }),
    );

    expect(tools.map((tool) => tool.name)).toEqual(['ok']);
  });

  it('takes args as an array, with the program already supplied', () => {
    const [ddgr] = toolboxTools(toolboxOf({ expose: 'tools' }));
    const parsed = ddgr?.parseArgs({ args: ['--json', 'sqlite wal'] });

    expect(parsed?.ok).toBe(true);
    // Required rather than defaulted: "always send it, sometimes empty" is a
    // simpler contract for a model than "omit it unless you need it".
    expect(ddgr?.parseArgs({}).ok).toBe(false);
  });
});

describe('toolboxPermissions', () => {
  it('is empty unless the entries are real callables', () => {
    // Nothing to permission when the box is only a prompt section: those
    // programs are reached through `exec`, and `exec`'s permission is theirs.
    expect(toolboxPermissions(toolboxOf())).toEqual({});
  });

  it('reports the manifest default per program', () => {
    expect(toolboxPermissions(toolboxOf({ expose: 'tools' }))).toEqual({
      ddgr: 'ask',
      fetch: 'ask',
    });
  });

  it('carries a declared permission through', () => {
    const box = toolboxOf({
      expose: 'tools',
      tools: [
        { name: 'search', use: 'Search.', permission: 'allow' },
        { name: 'nmap', use: 'Scan.', permission: 'deny' },
      ],
    });

    expect(toolboxPermissions(box)).toEqual({ search: 'allow', nmap: 'deny' });
  });

  it('skips an entry no provider would accept, exactly as the callables do', () => {
    const box = toolboxOf({
      expose: 'tools',
      tools: [{ name: 'ok', use: 'Fine.' }, { name: 'not ok' }],
    });

    expect(Object.keys(toolboxPermissions(box))).toEqual(['ok']);
    expect(toolboxTools(box).map((tool) => tool.name)).toEqual(['ok']);
  });

  it("lets an agent's override win over the manifest", () => {
    const box = toolboxOf({ expose: 'tools' });

    expect(toolboxPermissions(box, { ddgr: 'allow' })).toEqual({
      ddgr: 'allow',
      // Unnamed and no `*`, so the manifest still answers for it.
      fetch: 'ask',
    });
  });

  it('takes `*` as the default for every entry left unnamed', () => {
    // The case the wildcard exists for: "only these" without enumerating the
    // twenty-three programs the agent is not getting.
    const box = toolboxOf({ expose: 'tools' });

    expect(toolboxPermissions(box, { '*': 'deny', fetch: 'allow' })).toEqual({
      ddgr: 'deny',
      fetch: 'allow',
    });
  });

  it('may widen as well as narrow, because a manifest is not a ceiling', () => {
    // `exec` can reach the program either way, so the manifest's permission is
    // the box author's opinion. `network.maxMode` is the boundary, and it is
    // intersected rather than overridden.
    const box = toolboxOf({
      expose: 'tools',
      tools: [{ name: 'nmap', use: 'Scan.', permission: 'deny' }],
    });

    expect(toolboxPermissions(box, { nmap: 'allow' })).toEqual({
      nmap: 'allow',
    });
  });
});

describe('visibleToolboxEntries', () => {
  it('is every entry when nothing is overridden', () => {
    expect(
      visibleToolboxEntries(toolboxOf()).map((entry) => entry.name),
    ).toEqual(['ddgr', 'fetch']);
  });

  it('drops what the agent denied, so the prose matches the schemas', () => {
    expect(
      visibleToolboxEntries(toolboxOf({ expose: 'tools' }), {
        '*': 'deny',
        fetch: 'allow',
      }).map((entry) => entry.name),
    ).toEqual(['fetch']);
  });

  it('applies to a prompt-only box, where prose is the whole mechanism', () => {
    // No callables and so no permission map at all — every program is reached
    // through `exec`. An override that did nothing here would do nothing
    // anywhere, which is why this is blind to `expose`.
    expect(toolboxPermissions(toolboxOf(), { '*': 'deny' })).toEqual({});
    expect(
      visibleToolboxEntries(toolboxOf(), { ddgr: 'deny' }).map(
        (entry) => entry.name,
      ),
    ).toEqual(['fetch']);
  });
});

describe('withToolboxTools', () => {
  const base = (): ToolRegistry => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, DEFAULT_TOOLS_CONFIG);
    return registry;
  };

  const box = toolboxOf({ expose: 'tools' });
  // What the runtime hands in: the manifest's own defaults, with any agent
  // override already merged over them.
  const permissionsOf = toolboxPermissions;

  it('lays the toolbox over the built-ins, sorted as one list', () => {
    const scope = withToolboxTools(
      base(),
      toolboxTools(box),
      permissionsOf(box),
    );
    const names = scope.definitions().map((definition) => definition.name);

    expect(names).toContain('ddgr');
    expect(names).toContain('read_file');
    expect([...names]).toEqual([...names].sort());
  });

  it('returns the base untouched when nothing is exposed', () => {
    const registry = base();
    expect(withToolboxTools(registry, [], {})).toBe(registry);
  });

  it('never sends the model a program the agent was not given', () => {
    // The end of the chain the preset's `toolbox.tools` starts: `{'*': 'deny',
    // ddgr: 'allow'}` resolves to a permission map, and the map is what decides
    // which definitions the provider is sent. A `deny` is an absence, not a
    // refusal at call time — which is the point, because the cost it saves is
    // the 60–80 tokens the definition would carry on every request.
    const scope = withToolboxTools(
      base(),
      toolboxTools(box),
      permissionsOf(box, { '*': 'deny', ddgr: 'allow' }),
    );
    const names = scope.definitions().map((definition) => definition.name);

    expect(names).toContain('ddgr');
    expect(names).not.toContain('fetch');
    // The built-ins are untouched: this map speaks only for the box.
    expect(names).toContain('read_file');
    expect(scope.get('fetch')).toBeUndefined();
  });

  it('resolves a toolbox name to the toolbox tool, not the registry', () => {
    const scope = withToolboxTools(
      base(),
      toolboxTools(box),
      permissionsOf(box),
    );

    expect(scope.get('ddgr')?.name).toBe('ddgr');
    expect(scope.get('read_file')?.name).toBe('read_file');
    expect(scope.get('nothing')).toBeUndefined();
  });

  it('reports the overlay tool own permission and defers to the base otherwise', () => {
    const scope = withToolboxTools(base(), toolboxTools(box), {
      ...permissionsOf(box),
      ddgr: 'allow',
    });

    expect(scope.permissionFor('ddgr')).toBe('allow');
    // `fetch` keeps the manifest's default; `read_file` is the base's answer.
    expect(scope.permissionFor('fetch')).toBe('ask');
    expect(scope.permissionFor('read_file')).toBe('allow');
  });

  it('hides an overlay tool the agent switched off', () => {
    // A toolbox program is not exempt from the map just because the operator
    // chose the toolbox — the manifest supplies a default, not a guarantee.
    const scope = withToolboxTools(base(), toolboxTools(box), {
      ...permissionsOf(box),
      ddgr: 'deny',
    });

    expect(
      scope.definitions().map((definition) => definition.name),
    ).not.toContain('ddgr');
    expect(scope.get('ddgr')).toBeUndefined();
  });

  it('runs a toolbox tool through the context runner, as exec would', async () => {
    // The whole point: this is a *spelling* of exec, so the guard, the runner and
    // the container all apply unchanged.
    const seen: string[][] = [];
    const runner: CommandRunner = {
      async run(request) {
        seen.push([request.plan.file, ...request.plan.args]);
        return {
          stdout: '[]',
          stderr: '',
          truncated: false,
          code: 0,
          signal: null,
          timedOut: false,
        };
      },
    };

    const tempDir = mkdtempSync(join(tmpdir(), 'ghostai-tbt-'));
    const root = join(realpathSync(tempDir), 'workspace');
    try {
      const context: ToolContext = {
        jail: new WorkspaceJail({ root }),
        signal: new AbortController().signal,
        config: DEFAULT_TOOLS_CONFIG,
        runner,
        sandboxed: true,
      };
      const scope = withToolboxTools(
        base(),
        toolboxTools(box),
        permissionsOf(box),
      );

      const result = await scope.execute(
        {
          name: 'ddgr',
          argumentsJson: JSON.stringify({ args: ['--json', 'q'] }),
        },
        context,
      );

      expect(result.isError).toBe(false);
      expect(seen[0]).toEqual(['ddgr', '--json', 'q']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * `args` sent as a string instead of an array.
 *
 * The schema advertises `string[]` and models send a string anyway, often a
 * damaged one. Refusing is correct and also a wasted turn — see `argv.ts` for
 * the observed input and why accepting it is the better trade.
 */
describe('toolboxTool: a model that sends args as a string', () => {
  const box = ToolboxSchema.parse({
    schema: 'ghostai.toolbox/1',
    name: 'research',
    image: `sha256:${'b'.repeat(64)}`,
    expose: 'tools',
    tools: [{ name: 'search', use: 'Search the web.', requiresArgs: true }],
  });

  it('accepts the half-serialised array a model actually produced', () => {
    const tool = toolboxTool(box, box.tools[0]!)!;

    const parsed = tool.parseArgs({
      args: '[0] SUFFOLK wildfire 2024 fires reports UK US news updates"]',
    });

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && (parsed.args as { args: string[] }).args[0]).toBe(
      'SUFFOLK',
    );
  });

  it('still refuses a call with nothing in it', () => {
    // Coercion is not permissiveness: `requiresArgs` is checked *after* it, so a
    // program that does nothing without an argument still says so.
    const tool = toolboxTool(box, box.tools[0]!)!;

    expect(tool.parseArgs({ args: '' }).ok).toBe(false);
    expect(tool.parseArgs({ args: [] }).ok).toBe(false);
  });

  it('keeps advertising an array, because that is what a capable model should send', () => {
    // The coercion is a backstop. If the *advertised* type became `string`, every
    // model would send one and the argv contract would be guesswork every time.
    const tool = toolboxTool(box, box.tools[0]!)!;

    expect(JSON.stringify(tool.parameters)).toContain('"array"');
  });
});
