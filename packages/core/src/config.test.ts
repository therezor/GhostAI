import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, parseConfig, saveConfig } from './config.js';
import { isGhostError } from './errors.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-config-'));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(root: string, value: unknown): string {
  const file = join(root, 'config.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseConfig', () => {
  it('fills every default from an empty object', () => {
    const config = parseConfig('{}', 'config.json');
    expect(config.agents.defaults.provider).toBe('auto');
    expect(config.server.port).toBe(3000);
    expect(config.tools.approvalTimeoutMs).toBe(5 * 60 * 1000);
  });

  it('names the file and the syntax problem on malformed JSON', () => {
    try {
      parseConfig('{ "agents": ', '/etc/ghost/config.json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      if (!isGhostError(error)) return;
      expect(error.kind).toBe('config');
      expect(error.message).toContain('/etc/ghost/config.json');
      expect(error.message).toContain('not valid JSON');
    }
  });

  it('reports invalid settings as dotted paths, not as arrays', () => {
    // The point of the flattening: `agents.defaults.temperature` is a string an
    // operator can search their config file for.
    try {
      parseConfig(JSON.stringify({ agents: { defaults: { temperature: 9 } } }), 'config.json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      if (!isGhostError(error)) return;
      expect(error.message).toContain('agents.defaults.temperature');
      expect(error.details.issues).toHaveLength(1);
    }
  });

  it('labels a root-level type error rather than emitting an empty path', () => {
    try {
      parseConfig('[]', 'config.json');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
      if (!isGhostError(error)) return;
      expect(error.message).toContain('(root)');
    }
  });
});

describe('loadConfig', () => {
  it('returns schema defaults when no file exists', () => {
    const root = tempHome();
    const loaded = loadConfig({ root });

    expect(loaded.fromFile).toBe(false);
    expect(loaded.file).toBe(join(root, 'config.json'));
    expect(loaded.config.agents.defaults.maxToolIterations).toBe(40);
  });

  it('reads the file when there is one', () => {
    const root = tempHome();
    writeConfig(root, { agents: { defaults: { model: 'qwen3:8b', provider: 'ollama' } } });

    const loaded = loadConfig({ root });
    expect(loaded.fromFile).toBe(true);
    expect(loaded.config.agents.defaults.model).toBe('qwen3:8b');
    expect(loaded.config.agents.defaults.provider).toBe('ollama');
  });

  it('refuses a provider entry that does not name a type', () => {
    // There is no migration path: the schema is the only shape a config may be
    // in, so a file written against an older one is an error that names the key
    // rather than something quietly rewritten underneath the operator.
    const root = tempHome();
    writeConfig(root, { providers: { ollama: { apiBase: 'http://gpu.lan:11434/v1' } } });

    expect(() => loadConfig({ root })).toThrow(/providers\.ollama\.type/);
  });

  it('does not write a config file for an install that has none', () => {
    const root = tempHome();
    const loaded = loadConfig({ root });
    expect(loaded.fromFile).toBe(false);
    expect(existsSync(join(root, 'config.json'))).toBe(false);
  });

  it('keeps the workspace under the root when the config names none', () => {
    // The regression this guards: a default of the literal `~/.ghostai/workspace`
    // restates the *default* root, so an install relocated with GHOSTAI_HOME
    // would silently point the agent's filesystem tools back at the home
    // directory it thought it had left.
    const root = tempHome();
    const loaded = loadConfig({ root, home: '/home/someone-else' });

    expect(loaded.config.agents.defaults.workspace).toBe('');
    expect(loaded.paths.workspace).toBe(join(root, 'workspace'));
  });

  it('folds the config workspace into the resolved paths', () => {
    const root = tempHome();
    writeConfig(root, { agents: { defaults: { workspace: 'projects/alpha' } } });

    const loaded = loadConfig({ root });
    // Relative to the root, not the process cwd: a workspace that moved because
    // a service restarted elsewhere would orphan the agent's own files.
    expect(loaded.paths.workspace).toBe(resolve(root, 'projects/alpha'));
  });

  it('expands ~ in the config workspace against the given home', () => {
    const root = tempHome();
    const home = tempHome();
    writeConfig(root, { agents: { defaults: { workspace: '~/ghost-work' } } });

    const loaded = loadConfig({ root, home });
    expect(loaded.paths.workspace).toBe(join(home, 'ghost-work'));
  });

  it('lets an explicit workspace win over the config file', () => {
    const root = tempHome();
    writeConfig(root, { agents: { defaults: { workspace: 'from-config' } } });

    const loaded = loadConfig({ root, workspace: resolve(root, 'from-flag') });
    expect(loaded.paths.workspace).toBe(resolve(root, 'from-flag'));
  });

  it('honours an explicit file over <root>/config.json', () => {
    const root = tempHome();
    const other = join(tempHome(), 'elsewhere.json');
    writeFileSync(other, JSON.stringify({ server: { port: 8080 } }));

    const loaded = loadConfig({ root, file: other });
    expect(loaded.file).toBe(other);
    expect(loaded.config.server.port).toBe(8080);
  });

  it('refuses a malformed config rather than falling back to defaults', () => {
    // Falling back would silently discard everything the operator wrote, and
    // the first symptom would be an agent talking to the wrong provider.
    const root = tempHome();
    writeConfig(root, '{ "server": { "port": "3000" } }');

    expect(() => loadConfig({ root })).toThrow(/server\.port/);
  });

  it('surfaces an unreadable file instead of treating it as absent', () => {
    const root = tempHome();
    // A directory where the config file should be: readable in principle,
    // EISDIR in practice, and definitely not "no config here".
    expect(() => loadConfig({ root, file: root })).toThrow(/could not be read/);
  });

  it('reads GHOSTAI_HOME when no root is given', () => {
    const root = tempHome();
    writeConfig(root, { server: { port: 4100 } });

    const loaded = loadConfig({ env: { GHOSTAI_HOME: root } });
    expect(loaded.config.server.port).toBe(4100);
    expect(loaded.paths.root).toBe(resolve(root));
  });
});

describe('saveConfig', () => {
  it('round-trips through loadConfig', () => {
    const root = tempHome();
    const file = join(root, 'config.json');
    const config = parseConfig('{}', file);

    saveConfig(file, { ...config, server: { ...config.server, port: 4242 } });

    expect(loadConfig({ root }).config.server.port).toBe(4242);
  });

  it('writes a file a human can read and edit', () => {
    const root = tempHome();
    const file = join(root, 'config.json');

    saveConfig(file, parseConfig('{}', file));

    const text = readFileSync(file, 'utf8');
    expect(text.startsWith('{\n  "agents"')).toBe(true);
    expect(text.endsWith('}\n')).toBe(true);
  });

  it('creates the directory it is asked to write into', () => {
    const file = join(tempHome(), 'nested', 'deeper', 'config.json');

    saveConfig(file, parseConfig('{}', file));

    expect(loadConfig({ file, root: tempHome() }).fromFile).toBe(true);
  });

  it('refuses to write settings the next boot would reject', () => {
    const file = join(tempHome(), 'config.json');
    const config = parseConfig('{}', file);
    const broken = { ...config, server: { ...config.server, port: 70_000 } };

    expect(() => saveConfig(file, broken)).toThrow(/Refusing to write/);
    expect(existsSync(file)).toBe(false);
  });

  it('leaves the previous file in place when the write fails', () => {
    const root = tempHome();
    const file = join(root, 'config.json');
    saveConfig(file, parseConfig('{}', file));
    const before = readFileSync(file, 'utf8');

    // A directory where the temp file wants to go: the write fails, and the
    // rename that would have replaced the real file never runs.
    mkdirSync(`${file}.tmp`);

    expect(() => saveConfig(file, parseConfig('{"server":{"port":4242}}', file))).toThrow(
      /could not be written/,
    );
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
