import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOME_ENV_VAR,
  agentDirFor,
  ensureDir,
  extensionDataDirFor,
  extensionDirFor,
  expandHome,
  resolveGhostPaths,
  resolvePath,
  sharedDirFor,
} from '#src/paths.js';

const HOME = '/home/ghost';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-paths-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('expandHome', () => {
  it('expands a bare tilde', () => {
    expect(expandHome('~', HOME)).toBe(HOME);
  });

  it('expands a tilde-rooted path', () => {
    expect(expandHome('~/.ghostai/workspace', HOME)).toBe(
      join(HOME, '.ghostai/workspace'),
    );
  });

  it('leaves ~user alone rather than guessing', () => {
    // Resolving another account's home needs a passwd lookup, and treating
    // `~alice` as a directory literally named `~alice` is the predictable wrong
    // answer rather than the surprising one.
    expect(expandHome('~alice/docs', HOME)).toBe('~alice/docs');
  });

  it('leaves ordinary paths alone', () => {
    expect(expandHome('/var/data', HOME)).toBe('/var/data');
    expect(expandHome('relative/dir', HOME)).toBe('relative/dir');
    expect(expandHome('', HOME)).toBe('');
  });

  it('does not expand a tilde that is not leading', () => {
    expect(expandHome('/opt/~/x', HOME)).toBe('/opt/~/x');
  });
});

describe('resolvePath', () => {
  it('keeps an absolute path absolute', () => {
    expect(resolvePath('/var/data', '/base')).toBe(resolve('/var/data'));
  });

  it('resolves a relative path against the base', () => {
    expect(resolvePath('workspace', '/base')).toBe(resolve('/base/workspace'));
  });

  it('normalises traversal', () => {
    expect(resolvePath('../sibling', '/base/dir')).toBe(
      resolve('/base/sibling'),
    );
  });
});

describe('resolveGhostPaths', () => {
  const options = { home: HOME, env: {} };

  it('derives everything from the default root', () => {
    const paths = resolveGhostPaths(options);
    const root = resolve(HOME, '.ghostai');

    expect(paths).toEqual({
      root,
      workspace: join(root, 'workspace'),
      agentsDir: join(root, 'agents'),
      sharedDir: join(root, 'shared'),
      toolboxesDir: join(root, 'toolboxes'),
      runsDir: join(root, 'runs'),
      configFile: join(root, 'config.json'),
      dbFile: join(root, 'ghost.db'),
      logsDir: join(root, 'logs'),
      extensionsDir: join(root, 'extensions'),
      extensionDataDir: join(root, 'extension-data'),
      vaultFile: join(root, 'vault.json'),
      keyFile: join(root, 'vault.key'),
    });
  });

  it('honours the home environment variable', () => {
    const paths = resolveGhostPaths({
      home: HOME,
      env: { [HOME_ENV_VAR]: '/srv/ghost' },
    });
    expect(paths.root).toBe(resolve('/srv/ghost'));
    expect(paths.dbFile).toBe(resolve('/srv/ghost/ghost.db'));
  });

  it('expands a tilde in the environment variable', () => {
    const paths = resolveGhostPaths({
      home: HOME,
      env: { [HOME_ENV_VAR]: '~/ghost-data' },
    });
    expect(paths.root).toBe(resolve(HOME, 'ghost-data'));
  });

  it('lets an explicit root win over the environment', () => {
    const paths = resolveGhostPaths({
      home: HOME,
      env: { [HOME_ENV_VAR]: '/from/env' },
      root: '/explicit',
    });
    expect(paths.root).toBe(resolve('/explicit'));
  });

  it('resolves a relative workspace against the root, not the cwd', () => {
    // A service restarted from a different directory must not end up with a
    // different workspace while the database still points at the old one.
    const paths = resolveGhostPaths({
      ...options,
      root: '/srv/ghost',
      workspace: 'files',
    });
    expect(paths.workspace).toBe(resolve('/srv/ghost/files'));
  });

  it('accepts an absolute workspace outside the root', () => {
    const paths = resolveGhostPaths({
      ...options,
      root: '/srv/ghost',
      workspace: '/mnt/data',
    });
    expect(paths.workspace).toBe(resolve('/mnt/data'));
  });

  it('expands a tilde in the workspace', () => {
    const paths = resolveGhostPaths({ ...options, workspace: '~/projects' });
    expect(paths.workspace).toBe(resolve(HOME, 'projects'));
  });
});

describe('ensureDir', () => {
  it('creates nested directories and returns the path', () => {
    const target = join(tempDir(), 'a', 'b', 'c');
    expect(ensureDir(target)).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('is idempotent', () => {
    const target = join(tempDir(), 'once');
    ensureDir(target);
    expect(() => ensureDir(target)).not.toThrow();
  });

  it('creates the directory private to the user', () => {
    const target = join(tempDir(), 'private');
    ensureDir(target);
    // The vault keyfile and every session transcript live under directories
    // created this way; the default umask would leave them world-readable.
    expect(statSync(target).mode & 0o077).toBe(0);
  });
});

describe('agentDirFor', () => {
  const paths = resolveGhostPaths({ home: HOME, env: {} });

  it('gives each agent a directory of its own', () => {
    expect(agentDirFor(paths, 'reviewer')).toBe(
      join(paths.agentsDir, 'reviewer'),
    );
  });

  it('gives the default one too, rather than the parent', () => {
    // Unlike a workspace, `default` is not the parent of the others — an agent
    // whose memory sat one level up would see every other agent's.
    expect(agentDirFor(paths, 'default')).toBe(
      join(paths.agentsDir, 'default'),
    );
  });

  it('keeps every agent out of the workspace the tools can reach', () => {
    // The jail root is the workspace, so memory kept inside it would be
    // writable by `write_file` — prompt injection as a way to rewrite the
    // agent's own system prompt.
    expect(agentDirFor(paths, 'reviewer').startsWith(paths.workspace)).toBe(
      false,
    );
  });

  it.each(['..', 'a/b', 'Reviewer', '', '~evil'])('refuses %j', (id) => {
    expect(() => agentDirFor(paths, id)).toThrow(/Not an agent id/);
  });
});

describe('sharedDirFor', () => {
  const paths = resolveGhostPaths({ home: HOME, env: {} });

  it('keys the shared layer by workspace, not by agent', () => {
    expect(sharedDirFor(paths, 'default')).toBe(
      join(paths.sharedDir, 'default'),
    );
    expect(sharedDirFor(paths, 'client-acme')).toBe(
      join(paths.sharedDir, 'client-acme'),
    );
  });

  it('stays outside the workspace too', () => {
    expect(sharedDirFor(paths, 'default').startsWith(paths.workspace)).toBe(
      false,
    );
  });

  it.each(['..', 'a/b', 'Work', ''])('refuses %j', (id) => {
    expect(() => sharedDirFor(paths, id)).toThrow(/Not a workspace id/);
  });
});

describe('extensionDirFor and extensionDataDirFor', () => {
  const paths = resolveGhostPaths({ home: HOME, env: {} });

  it('gives each extension an install directory of its own', () => {
    expect(extensionDirFor(paths, 'slack')).toBe(
      join(paths.extensionsDir, 'slack'),
    );
  });

  it('keeps what an extension writes out of what was approved', () => {
    // The approval is a digest over every byte under the install directory, so
    // state written in there would revoke the extension's own approval on the
    // first write. Sibling directories, never nested.
    const install = extensionDirFor(paths, 'slack');
    const data = extensionDataDirFor(paths, 'slack');

    expect(data).toBe(join(paths.extensionDataDir, 'slack'));
    expect(data.startsWith(install)).toBe(false);
    expect(install.startsWith(data)).toBe(false);
  });

  it('keeps both outside the workspace the tools can reach', () => {
    expect(extensionDirFor(paths, 'slack').startsWith(paths.workspace)).toBe(
      false,
    );
    expect(
      extensionDataDirFor(paths, 'slack').startsWith(paths.workspace),
    ).toBe(false);
  });

  it.each(['..', 'a/b', 'Slack', '', '~evil'])('refuses %j', (id) => {
    expect(() => extensionDirFor(paths, id)).toThrow(/Not an extension id/);
    expect(() => extensionDataDirFor(paths, id)).toThrow(/Not an extension id/);
  });
});
