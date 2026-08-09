import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  AgentEntrySchema,
  AgentPresetSchema,
  DEFAULT_AGENT_TOOLS,
  ToolboxSchema,
  presetToAgentEntry,
  type AgentPreset,
  type Toolbox,
} from '#src/index.js';

const MINIMAL = { schema: 'ghostai.agent-preset/1', id: 'researcher' };

describe('AgentPresetSchema', () => {
  it('needs only a schema tag and an id', () => {
    const preset = AgentPresetSchema.parse(MINIMAL);

    expect(preset.label).toBe('');
    expect(preset.promptMode).toBe('template');
    expect(preset.tools).toEqual(DEFAULT_AGENT_TOOLS);
    expect(preset.toolbox).toEqual({
      name: '',
      network: { mode: 'none', allow: [] },
    });
    expect(preset.subagents).toEqual([]);
    // Unset means inherit `agents.defaults`, which only an absent key can say.
    expect(preset.toolsEnabled).toBeUndefined();
  });

  it('refuses a schema tag it does not recognise', () => {
    // A literal rather than a string, for the reason the toolbox manifest
    // gives: a breaking format change has to fail loudly on the old file
    // rather than parse it into something that means something else now.
    expect(() =>
      AgentPresetSchema.parse({ ...MINIMAL, schema: 'ghostai.agent/1' }),
    ).toThrow();
  });

  it('cannot name an image, caps or limits', () => {
    // The whole point of the shape: a preset reuses `AgentToolboxSchema`, so
    // the boundary fields live only in the operator-approved manifest and a
    // preset has no field through which to widen them.
    const preset = AgentPresetSchema.parse({
      ...MINIMAL,
      toolbox: { name: 'web-research', network: { mode: 'open' } },
    });

    expect(preset.toolbox).toEqual({
      name: 'web-research',
      network: { mode: 'open', allow: [] },
    });
    expect('image' in preset.toolbox).toBe(false);
  });
});

describe('presetToAgentEntry', () => {
  it('installs enabled, with the entry schema applying its own defaults', () => {
    const entry = presetToAgentEntry(
      AgentPresetSchema.parse({
        ...MINIMAL,
        label: 'Researcher',
        systemPrompt: '# {{name}}\n\nResearch things.',
      }),
    );

    expect(entry.enabled).toBe(true);
    expect(entry.label).toBe('Researcher');
    expect(entry.systemPrompt).toContain('Research things.');
    // Round-trips through the schema that owns the shape.
    expect(AgentEntrySchema.parse(entry)).toEqual(entry);
  });

  it('leaves toolsEnabled out of the patch unless the preset set it', () => {
    const inherited = presetToAgentEntry(AgentPresetSchema.parse(MINIMAL));
    expect('toolsEnabled' in inherited).toBe(false);

    const disabled = presetToAgentEntry(
      AgentPresetSchema.parse({ ...MINIMAL, toolsEnabled: false }),
    );
    expect(disabled.toolsEnabled).toBe(false);
  });

  it('carries neither the schema tag nor the id into the entry', () => {
    // The id becomes the `agents.list` key; the tag described the file. An
    // entry holding either would round-trip them into every settings save.
    const entry = presetToAgentEntry(AgentPresetSchema.parse(MINIMAL));

    expect('id' in entry).toBe(false);
    expect('schema' in entry).toBe(false);
  });
});

/**
 * The catalogue is data no compiler checks, so this is the gate that keeps it
 * honest in CI without Docker. Two independent sweeps, because presets and
 * toolboxes are two directories now rather than one tree: every manifest
 * parses and matches its directory name, and every preset parses and matches
 * its filename. The third assertion joins them — a preset naming a toolbox may
 * not ask for more network than that toolbox's ceiling grants.
 */
describe('the catalogue', () => {
  const root = fileURLToPath(new URL('../../../catalogue/', import.meta.url));
  const DUMMY_DIGEST = `sha256:${'0'.repeat(64)}`;
  const NETWORK_ORDER = { none: 0, allowlist: 1, open: 2 } as const;

  const toolboxes = readdirSync(join(root, 'toolboxes'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      existsSync(join(root, 'toolboxes', name, 'toolbox.json')),
    );

  const presets = readdirSync(join(root, 'presets'))
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => entry.slice(0, -'.json'.length));

  function manifestFor(name: string): Toolbox {
    const text = readFileSync(
      join(root, 'toolboxes', name, 'toolbox.json'),
      'utf8',
    ).replace('__IMAGE_ID__', DUMMY_DIGEST);
    return ToolboxSchema.parse(JSON.parse(text));
  }

  function presetFor(id: string): AgentPreset {
    return AgentPresetSchema.parse(
      JSON.parse(readFileSync(join(root, 'presets', `${id}.json`), 'utf8')),
    );
  }

  it('ships toolboxes and presets', () => {
    expect(toolboxes.length).toBeGreaterThan(0);
    expect(presets.length).toBeGreaterThan(0);
  });

  it.each(toolboxes)(
    'toolboxes/%s: parses, and is named for its directory',
    (name) => {
      expect(manifestFor(name).name).toBe(name);
    },
  );

  it.each(presets)('presets/%s.json: parses, and is named for its id', (id) => {
    // The filename is the id the CLI installs under and lists, so the two
    // disagreeing would install an agent nobody asked for.
    expect(presetFor(id).id).toBe(id);
  });

  it.each(presets)(
    'presets/%s.json: stays within its toolbox ceiling',
    (id) => {
      const preset = presetFor(id);
      if (preset.toolbox.name === '') return; // runs on the host; nothing to check

      expect(toolboxes).toContain(preset.toolbox.name);
      // The runtime would intersect these anyway, but a shipped pair that
      // disagrees is a documentation bug worth failing on.
      expect(NETWORK_ORDER[preset.toolbox.network.mode]).toBeLessThanOrEqual(
        NETWORK_ORDER[manifestFor(preset.toolbox.name).network.maxMode],
      );
    },
  );
});
