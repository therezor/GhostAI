import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGhostError } from './errors.js';
import { resolveGhostPaths, workspaceDirFor, type GhostPaths } from './paths.js';
import { SessionStore } from './session-store.js';
import {
  DEFAULT_WORKSPACE_ID,
  RESERVED_WORKSPACE_IDS,
  deriveSlug,
  isWorkspaceId,
} from './workspace-id.js';
import { WorkspaceStore } from './workspace-store.js';

let base: string;
let paths: GhostPaths;
let db: DatabaseSync;
let store: WorkspaceStore;

const kindOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return isGhostError(error) ? error.kind : 'not-a-ghost-error';
  }
  return 'did-not-throw';
};

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'ghostai-workspaces-')));
  paths = resolveGhostPaths({ root: base });
  mkdirSync(paths.workspace, { recursive: true });
  db = new DatabaseSync(':memory:');
  store = new WorkspaceStore({ database: db, paths });
});

afterEach(() => {
  db.close();
  rmSync(base, { recursive: true, force: true });
});

describe('workspace ids', () => {
  it.each([
    ['a single character', 'a'],
    ['digits', '2024'],
    ['hyphens inside', 'client-acme'],
    ['the default', 'default'],
    ['forty characters', 'a'.repeat(40)],
  ])('accepts %s', (_name, id) => {
    expect(isWorkspaceId(id)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['a traversal', '..'],
    ['a separator', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a colon', 'c:'],
    ['a NUL byte', 'a\0b'],
    ['a home prefix', '~ws'],
    ['a leading hyphen', '-ws'],
    ['a trailing hyphen', 'ws-'],
    ['uppercase', 'Work'],
    ['a space', 'my ws'],
    ['forty-one characters', 'a'.repeat(41)],
  ])('refuses %s', (_name, id) => {
    expect(isWorkspaceId(id)).toBe(false);
  });

  it('refuses uppercase because case-folding filesystems would share one directory', () => {
    // `Work` and `work` on APFS or NTFS are two rows over one tree — two
    // workspaces that believe they are isolated and are not.
    expect(isWorkspaceId('Work')).toBe(false);
    expect(deriveSlug('Work')).toBe('work');
  });

  it.each([
    ['Client Acme', 'client-acme'],
    ['  Spaced  out  ', 'spaced-out'],
    ['Ünïcödé', 'n-c-d'],
    ['///', 'workspace'],
    ['', 'workspace'],
    ['default', 'workspace'],
    ['CON', 'workspace'],
  ])('derives %j to %j', (name, expected) => {
    expect(deriveSlug(name)).toBe(expected);
  });

  it('always derives something legal, for any name at all', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const slug = deriveSlug(name);
        expect(isWorkspaceId(slug)).toBe(true);
        // And it can only ever name a child of the default workspace.
        expect(workspaceDirFor(paths, slug)).toBe(join(paths.workspace, slug));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('workspaceDirFor', () => {
  it('maps the default to the workspace root itself', () => {
    expect(workspaceDirFor(paths, DEFAULT_WORKSPACE_ID)).toBe(paths.workspace);
  });

  it('maps a named workspace to a folder inside it', () => {
    expect(workspaceDirFor(paths, 'acme')).toBe(join(paths.workspace, 'acme'));
  });

  it('re-validates, because ids arrive from request bodies and hand-edited rows', () => {
    for (const bad of ['../..', 'a/b', '~', 'C:', 'Work', '']) {
      expect(kindOf(() => workspaceDirFor(paths, bad))).toBe('invalid_input');
    }
  });

  it('resolves an id with no registry row, so a detached workspace keeps its files', () => {
    expect(workspaceDirFor(paths, 'detached')).toBe(join(paths.workspace, 'detached'));
  });
});

describe('WorkspaceStore', () => {
  it('bootstraps a default that is marked as such', () => {
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: DEFAULT_WORKSPACE_ID, isDefault: true, name: 'Default' });
  });

  it('bootstraps idempotently across two stores on one connection', () => {
    const second = new WorkspaceStore({ database: db, paths });
    expect(second.list()).toHaveLength(1);
  });

  it('creates a workspace and its directory', () => {
    const created = store.create({ name: 'Client Acme' });
    expect(created.id).toBe('client-acme');
    expect(created.isDefault).toBe(false);
    expect(statSync(join(paths.workspace, 'client-acme')).isDirectory()).toBe(true);
  });

  it('lists the default first, then by name', () => {
    store.create({ name: 'Zulu' });
    store.create({ name: 'alpha' });
    expect(store.list().map((row) => row.id)).toEqual([DEFAULT_WORKSPACE_ID, 'alpha', 'zulu']);
  });

  it('disambiguates a slug that is already taken', () => {
    expect(store.create({ name: 'Notes' }).id).toBe('notes');
    expect(store.create({ name: 'notes' }).id).toBe('notes-2');
  });

  it('keeps a disambiguated slug inside the length limit', () => {
    const long = 'x'.repeat(40);
    expect(store.create({ name: long }).id).toBe(long);
    const second = store.create({ name: long }).id;
    expect(isWorkspaceId(second)).toBe(true);
    expect(second).toHaveLength(40);
  });

  it('refuses an explicit id that is not a legal slug', () => {
    expect(kindOf(() => store.create({ name: 'Escape', id: '../etc' }))).toBe('invalid_input');
    expect(kindOf(() => store.create({ name: 'Shouty', id: 'Work' }))).toBe('invalid_input');
  });

  it('refuses a reserved id', () => {
    for (const id of ['default', 'con', 'nul', 'com1', 'lpt9']) {
      expect(RESERVED_WORKSPACE_IDS.has(id)).toBe(true);
      expect(kindOf(() => store.create({ name: 'Nope', id }))).toBe('invalid_input');
    }
  });

  it('refuses a duplicate id', () => {
    store.create({ name: 'Notes', id: 'notes' });
    expect(kindOf(() => store.create({ name: 'Notes again', id: 'notes' }))).toBe('conflict');
  });

  it('refuses a name that is only whitespace', () => {
    expect(kindOf(() => store.create({ name: '   ' }))).toBe('invalid_input');
  });

  it('adopts an existing directory, which is what makes delete-then-recreate work', () => {
    mkdirSync(join(paths.workspace, 'research'), { recursive: true });
    writeFileSync(join(paths.workspace, 'research', 'notes.md'), 'kept');

    const created = store.create({ name: 'Research', id: 'research' });
    expect(created.id).toBe('research');
    expect(statSync(join(paths.workspace, 'research', 'notes.md')).isFile()).toBe(true);
  });

  it('refuses a slug that collides with a file in the default workspace', () => {
    // Named workspaces are folders inside the default tree, so the agent or the
    // user can already have put something there. A file would make every
    // operation in that workspace fail with ENOTDIR.
    writeFileSync(join(paths.workspace, 'notes'), 'not a folder');
    expect(kindOf(() => store.create({ name: 'Notes', id: 'notes' }))).toBe('conflict');
  });

  it('renames without moving anything on disk', () => {
    const created = store.create({ name: 'Old' });
    const renamed = store.rename(created.id, 'New');
    expect(renamed.name).toBe('New');
    expect(store.get(created.id)?.name).toBe('New');
    expect(statSync(workspaceDirFor(paths, created.id)).isDirectory()).toBe(true);
  });

  it('refuses to rename something that is not there', () => {
    expect(kindOf(() => store.rename('ghost', 'New'))).toBe('not_found');
  });

  it('detaches without touching the files', () => {
    const created = store.create({ name: 'Research' });
    writeFileSync(join(workspaceDirFor(paths, created.id), 'notes.md'), 'kept');

    store.delete(created.id);

    expect(store.get(created.id)).toBeUndefined();
    expect(statSync(join(workspaceDirFor(paths, created.id), 'notes.md')).isFile()).toBe(true);
  });

  it('refuses to delete the default', () => {
    expect(kindOf(() => { store.delete(DEFAULT_WORKSPACE_ID); })).toBe('conflict');
  });

  it('refuses to delete something that is not there', () => {
    expect(kindOf(() => { store.delete('ghost'); })).toBe('not_found');
  });

  it('round-trips metadata', () => {
    const created = store.create({ name: 'Tagged', metadata: { colour: 'green' } });
    expect(store.get(created.id)?.metadata).toEqual({ colour: 'green' });
  });
});

describe('sessions and workspaces', () => {
  let sessions: SessionStore;

  beforeEach(() => {
    sessions = new SessionStore({ database: db });
  });

  it('defaults a session to the default workspace', () => {
    expect(sessions.ensureSession('web-1').workspaceId).toBe(DEFAULT_WORKSPACE_ID);
  });

  it('records the workspace a session was created in', () => {
    store.create({ name: 'Acme', id: 'acme' });
    expect(sessions.ensureSession('web-1', { workspaceId: 'acme' }).workspaceId).toBe('acme');
  });

  it('never moves a session once created, however it is re-opened', () => {
    // The rule that makes switching workspaces mid-turn safe: a turn resolves
    // its jail from the stored row, and the stored row cannot be talked into
    // changing by a later request that claims otherwise.
    sessions.ensureSession('web-1', { workspaceId: 'acme' });
    expect(sessions.ensureSession('web-1', { workspaceId: 'other' }).workspaceId).toBe('acme');
  });

  it('filters a listing by workspace', () => {
    sessions.ensureSession('a-1', { workspaceId: 'acme' });
    sessions.ensureSession('a-2', { workspaceId: 'acme' });
    sessions.ensureSession('d-1');

    expect(sessions.listSessions({ workspaceId: 'acme' }).map((row) => row.key).sort()).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(sessions.listSessions().map((row) => row.key)).toHaveLength(3);
  });

  it('counts and reassigns, which is the way through a blocked delete', () => {
    sessions.ensureSession('a-1', { workspaceId: 'acme' });
    sessions.ensureSession('a-2', { workspaceId: 'acme' });

    expect(sessions.countByWorkspace('acme')).toBe(2);
    expect(sessions.reassignWorkspace('acme', DEFAULT_WORKSPACE_ID)).toBe(2);
    expect(sessions.countByWorkspace('acme')).toBe(0);
    expect(sessions.countByWorkspace(DEFAULT_WORKSPACE_ID)).toBe(2);
  });

  it('leaves updated_at_ms alone when reassigning, so the session list does not reorder', () => {
    const created = sessions.ensureSession('a-1', { workspaceId: 'acme' });
    sessions.reassignWorkspace('acme', DEFAULT_WORKSPACE_ID);
    expect(sessions.getSession('a-1')?.updatedAtMs).toBe(created.updatedAtMs);
  });
});
