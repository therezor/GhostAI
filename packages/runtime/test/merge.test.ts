import { ConfigSchema } from '@ghostbot/protocol';
import { describe, expect, it } from 'vitest';

import { mergeConfigPatch } from '#src/merge.js';

const base = ConfigSchema.parse({});

describe('mergeConfigPatch', () => {
  it('leaves every field the patch does not mention', () => {
    // The whole point of `patchOf` over `.partial()`: saving one settings panel
    // must not rewrite the siblings back to their defaults.
    const merged = mergeConfigPatch(base, {
      agents: { defaults: { temperature: 0.7 } },
    });

    expect(merged.agents.defaults.temperature).toBe(0.7);
    expect(merged.agents.defaults.maxTokens).toBe(
      base.agents.defaults.maxTokens,
    );
    expect(merged.tools).toEqual(base.tools);
  });

  it('is the identity on an empty patch', () => {
    expect(mergeConfigPatch(base, {})).toEqual(base);
  });

  it('does not mutate the config it was given', () => {
    const before = structuredClone(base);
    mergeConfigPatch(base, { agents: { defaults: { model: 'llama3' } } });
    expect(base).toEqual(before);
  });

  it('replaces an array rather than appending to it', () => {
    const withBinaries = mergeConfigPatch(base, {
      tools: { exec: { allowedBinaries: ['git', 'rg'] } },
    });
    const replaced = mergeConfigPatch(withBinaries, {
      tools: { exec: { allowedBinaries: ['git'] } },
    });

    // There is no patch syntax for a removal, so a merging array would make
    // withdrawing an entry impossible.
    expect(replaced.tools.exec.allowedBinaries).toEqual(['git']);
  });

  it('replaces extraHeaders wholesale, so a header can be deleted', () => {
    const withHeaders = mergeConfigPatch(base, {
      providers: {
        openai: {
          type: 'openai',
          extraHeaders: { 'X-One': '1', 'X-Two': '2' },
        },
      },
    });
    const replaced = mergeConfigPatch(withHeaders, {
      providers: { openai: { extraHeaders: { 'X-One': '1' } } },
    });

    expect(replaced.providers.openai?.extraHeaders).toEqual({ 'X-One': '1' });
  });

  it('merges the providers record per instance id', () => {
    const first = mergeConfigPatch(base, {
      providers: { ollama: { type: 'ollama', apiBase: 'http://a/v1' } },
    });
    const second = mergeConfigPatch(first, {
      providers: { openai: { type: 'openai', apiBase: 'http://b/v1' } },
    });

    expect(second.providers.ollama?.apiBase).toBe('http://a/v1');
    expect(second.providers.openai?.apiBase).toBe('http://b/v1');
  });

  it('deletes a provider instance on an explicit null', () => {
    // The one token available for "remove this": `undefined` means "not
    // mentioned" and cannot survive JSON, so without this there is no way to
    // take back a provider an operator added.
    const two = mergeConfigPatch(base, {
      providers: {
        laptop: { type: 'ollama' },
        gpu: { type: 'ollama', apiBase: 'http://gpu.lan:11434/v1' },
      },
    });
    const one = mergeConfigPatch(two, { providers: { gpu: null } });

    expect(Object.keys(one.providers)).toEqual(['laptop']);
  });

  it('deletes an MCP server on an explicit null', () => {
    // `tools.mcpServers.*` has been in `DELETE_BY_NULL` since before there was
    // a client, and this is the first time anything could reach it: until the
    // patch schema restated the record as nullable per entry, zod refused the
    // null one layer above and this branch could never fire.
    const two = mergeConfigPatch(base, {
      tools: {
        mcpServers: {
          files: { command: 'npx' },
          github: { url: 'https://mcp.github.test/mcp' },
        },
      },
    });
    const one = mergeConfigPatch(two, {
      tools: { mcpServers: { github: null } },
    });

    expect(Object.keys(one.tools.mcpServers)).toEqual(['files']);
  });

  it('strips a null that says "unset" from a subtree being created', () => {
    // The merge used to hand a patch straight through whenever there was
    // nothing to merge it into, which skipped the delete-by-null pass — so a
    // `null` meaning "this server does not use OAuth" survived into the tree
    // and failed the re-parse. Deleting a key from nothing is a no-op; leaving
    // the token that says so in the result is not.
    const created = mergeConfigPatch(base, {
      tools: { mcpServers: { files: { command: 'npx', oauth: null } } },
    });

    expect(created.tools.mcpServers.files?.command).toBe('npx');
    expect(created.tools.mcpServers.files?.oauth).toBeUndefined();
  });

  it('removes an OAuth block an existing server had', () => {
    const withOauth = mergeConfigPatch(base, {
      tools: {
        mcpServers: {
          github: {
            url: 'https://mcp.github.test/mcp',
            oauth: {
              authUrl: 'https://auth.test/a',
              tokenUrl: 'https://auth.test/t',
              clientId: 'x',
              scopes: [],
              callbackTimeoutMs: 0,
            },
          },
        },
      },
    });
    expect(withOauth.tools.mcpServers.github?.oauth).toBeDefined();

    const without = mergeConfigPatch(withOauth, {
      tools: { mcpServers: { github: { oauth: null } } },
    });
    expect(without.tools.mcpServers.github?.oauth).toBeUndefined();
    // And the rest of the server is untouched.
    expect(without.tools.mcpServers.github?.url).toBe(
      'https://mcp.github.test/mcp',
    );
  });

  it('replaces an MCP server env rather than merging it key by key', () => {
    // The same argument as `providers.*.extraHeaders`: it is edited as one
    // block of text, so merging would leave no way to remove an entry.
    const two = mergeConfigPatch(base, {
      tools: {
        mcpServers: { files: { command: 'npx', env: { A: '1', B: '2' } } },
      },
    });
    const one = mergeConfigPatch(two, {
      tools: { mcpServers: { files: { env: { A: '1' } } } },
    });

    expect(one.tools.mcpServers.files?.env).toEqual({ A: '1' });
  });

  it('merges one MCP server without restating its siblings or its fields', () => {
    const first = mergeConfigPatch(base, {
      tools: { mcpServers: { files: { command: 'npx', args: ['-y', 'srv'] } } },
    });
    const second = mergeConfigPatch(first, {
      tools: { mcpServers: { files: { enabled: false } } },
    });

    expect(second.tools.mcpServers.files?.enabled).toBe(false);
    expect(second.tools.mcpServers.files?.args).toEqual(['-y', 'srv']);
  });

  it('merges the agents record per id, leaving the other agents alone', () => {
    const first = mergeConfigPatch(base, {
      agents: { list: { reviewer: { label: 'Reviewer', temperature: 0 } } },
    });
    const second = mergeConfigPatch(first, {
      agents: { list: { writer: { label: 'Writer' } } },
    });

    expect(second.agents.list.writer?.label).toBe('Writer');
    expect(second.agents.list.reviewer?.label).toBe('Reviewer');
    expect(second.agents.list.reviewer?.temperature).toBe(0);
  });

  it('replaces one agent wholesale, so clearing an override is expressible', () => {
    // Almost every field on an agent is an override that may be absent. If the
    // merge kept the fields a patch left out, emptying the model box in the
    // editor would silently keep the model that was just deleted.
    const pinned = mergeConfigPatch(base, {
      agents: {
        list: {
          reviewer: {
            label: 'Reviewer',
            model: 'claude-opus-5',
            temperature: 0,
          },
        },
      },
    });
    const cleared = mergeConfigPatch(pinned, {
      agents: { list: { reviewer: { label: 'Reviewer' } } },
    });

    expect(cleared.agents.list.reviewer?.label).toBe('Reviewer');
    expect(cleared.agents.list.reviewer?.model).toBeUndefined();
    expect(cleared.agents.list.reviewer?.temperature).toBeUndefined();
    // And the other agents are untouched — the replacement is per id.
    expect(cleared.agents.defaults).toEqual(base.agents.defaults);
  });

  it('deletes an agent on an explicit null', () => {
    const two = mergeConfigPatch(base, {
      agents: { list: { reviewer: {}, writer: {} } },
    });
    const one = mergeConfigPatch(two, { agents: { list: { writer: null } } });

    expect(Object.keys(one.agents.list)).toEqual(['reviewer']);
    // Deleting an agent must not disturb the defaults every other one inherits.
    expect(one.agents.defaults).toEqual(base.agents.defaults);
  });

  it("replaces an agent's tool map wholesale, so a tool can be removed", () => {
    // A deep merge here would make the second save a no-op: `exec` would
    // survive as `deny` and `write_file` would survive at `allow`, and there
    // would be no way to express "this agent has one tool".
    const wide = mergeConfigPatch(base, {
      agents: {
        list: {
          reviewer: {
            tools: { read_file: 'allow', write_file: 'allow', exec: 'deny' },
          },
        },
      },
    });
    const narrowed = mergeConfigPatch(wide, {
      agents: { list: { reviewer: { tools: { read_file: 'ask' } } } },
    });

    expect(narrowed.agents.list.reviewer?.tools).toEqual({ read_file: 'ask' });
  });

  it('clears an optional default on an explicit null', () => {
    // The reported bug: emptying the temperature box, saving, reloading, and
    // finding the old value still there. `agents.defaults` merges per field, so
    // the patch that omitted the key preserved it — `null` is the only token
    // that can say "remove this", and these two are safe to remove because both
    // are optional in the schema and a config without them still parses.
    const warm = mergeConfigPatch(base, {
      agents: { defaults: { temperature: 0.1, reasoningEffort: 'high' } },
    });
    expect(warm.agents.defaults.temperature).toBe(0.1);

    const cleared = mergeConfigPatch(warm, {
      agents: { defaults: { temperature: null, reasoningEffort: null } },
    });

    expect(cleared.agents.defaults.temperature).toBeUndefined();
    expect(cleared.agents.defaults.reasoningEffort).toBeUndefined();
    // The neighbouring fields are untouched — this is a deletion, not a reset.
    expect(cleared.agents.defaults.model).toBe(base.agents.defaults.model);
    expect(cleared.agents.defaults.maxTokens).toBe(
      base.agents.defaults.maxTokens,
    );
  });

  it('ignores a null on a path where deletion is not meaningful', () => {
    // A `null` that punched a hole in a struct would drop a setting and fail
    // the re-parse — or, worse, silently revert it to a default.
    expect(() =>
      mergeConfigPatch(base, {
        // Deliberately outside `DELETE_BY_NULL`; the schema is what refuses it.
        agents: { defaults: { model: null as unknown as string } },
      }),
    ).toThrow(/invalid settings/);
  });

  it('treats an explicit undefined as "not mentioned"', () => {
    // JSON cannot carry `undefined`; the only way it arrives is a JS caller
    // spreading an optional field, and reading that as a deletion would drop a
    // setting nobody named.
    const merged = mergeConfigPatch(base, {
      agents: { defaults: { model: undefined, temperature: 0.3 } },
    });

    expect(merged.agents.defaults.model).toBe(base.agents.defaults.model);
    expect(merged.agents.defaults.temperature).toBe(0.3);
  });

  it('keeps a channel extension block the schema does not name', () => {
    const merged = mergeConfigPatch(base, {
      channels: { telegram: { token: 'abc' } },
    });
    expect(merged.channels.telegram).toEqual({ token: 'abc' });
  });

  it('rejects a merge that produces settings the schema refuses, naming the path', () => {
    // The patch schema validates field by field; only the full schema knows the
    // result is a `Config`. This one gets past `ConfigPatchSchema` because the
    // caller bypassed it — which a JS caller can, and a route will not.
    expect(() =>
      mergeConfigPatch(base, { agents: { defaults: { temperature: 9 } } }),
    ).toThrow(/agents\.defaults\.temperature/);
  });

  it('does not cascade a delete into another agent’s delegations', () => {
    // A guard, not a feature. Healing a dangling delegation belongs to
    // `pruneDanglingSubagents`, which `reconfigure` owns: this merge is generic
    // and pure, and it is also what previews a patch. Cascading here would make
    // a preview change more than the patch said it would.
    const before = mergeConfigPatch(base, {
      agents: {
        list: {
          researcher: { label: 'Researcher' },
          main: {
            subagents: [{ id: 'researcher', prompt: '', permission: 'allow' }],
          },
        },
      },
    });

    const merged = mergeConfigPatch(before, {
      agents: { list: { researcher: null } },
    });

    expect(merged.agents.list.researcher).toBeUndefined();
    expect(merged.agents.list.main?.subagents.map((ref) => ref.id)).toEqual([
      'researcher',
    ]);
  });
  it('replaces one extension’s settings block wholesale', () => {
    // This layer does not know the block's shape — the extension parses it —
    // so it cannot tell a struct field from a record entry, and replacing is
    // the only rule that is right without knowing which.
    const before = mergeConfigPatch(base, {
      extensions: { settings: { slack: { channel: '#ops', quiet: true } } },
    });
    const after = mergeConfigPatch(before, {
      extensions: { settings: { slack: { channel: '#alerts' } } },
    });

    expect(after.extensions.settings.slack).toEqual({ channel: '#alerts' });
  });

  it('deletes an extension’s settings on an explicit null', () => {
    const before = mergeConfigPatch(base, {
      extensions: { settings: { slack: { channel: '#ops' } } },
    });
    const after = mergeConfigPatch(before, {
      extensions: { settings: { slack: null } },
    });

    expect(after.extensions.settings.slack).toBeUndefined();
  });

  it('leaves the other extension keys alone while settings change', () => {
    const before = mergeConfigPatch(base, {
      extensions: { disabled: ['slack'], settings: { slack: { a: 1 } } },
    });
    const after = mergeConfigPatch(before, {
      extensions: { settings: { slack: { a: 2 } } },
    });

    expect(after.extensions.disabled).toEqual(['slack']);
    expect(after.extensions.settings.slack).toEqual({ a: 2 });
  });
});
