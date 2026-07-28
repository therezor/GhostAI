import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { isGhostError } from './errors.js';
import { migrate } from './migrate.js';

/**
 * The `sessions` table exactly as it shipped before workspaces existed.
 *
 * Checked in verbatim rather than imported: the point of the test is that a
 * database created by the *old* code survives the upgrade, and importing the
 * current `SCHEMA` would test the migration against whatever the schema happens
 * to be today — which is the one thing that cannot go wrong.
 */
const SCHEMA_BEFORE_WORKSPACES = `
CREATE TABLE IF NOT EXISTS sessions (
  key                   TEXT    PRIMARY KEY,
  title                 TEXT    NOT NULL DEFAULT '',
  origin                TEXT    NOT NULL DEFAULT 'web',
  profile_id            TEXT,
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL,
  metadata_json         TEXT    NOT NULL DEFAULT '{}',
  last_consolidated_seq INTEGER NOT NULL DEFAULT 0,
  last_learned_seq      INTEGER NOT NULL DEFAULT 0,
  next_seq              INTEGER NOT NULL DEFAULT 1
) STRICT;
`;

const ADD_WORKSPACE = `ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'default';`;

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_BEFORE_WORKSPACES);
  db.prepare('INSERT INTO sessions (key, created_at_ms, updated_at_ms) VALUES (?, ?, ?)').run(
    'web-1',
    1,
    1,
  );
  return db;
}

const columns = (db: DatabaseSync): string[] =>
  db
    .prepare('SELECT name FROM pragma_table_info(?)')
    .all('sessions')
    .map((row) => String(row.name));

const versionOf = (db: DatabaseSync, name: string): number | undefined => {
  const row = db.prepare('SELECT version FROM schema_versions WHERE name = ?').get(name) as
    { readonly version: number } | undefined;
  return row?.version;
};

describe('migrate', () => {
  it('adds a column to a database written before the column existed', () => {
    const db = legacyDatabase();
    expect(columns(db)).not.toContain('workspace_id');

    migrate(db, 'sessions', [ADD_WORKSPACE]);

    expect(columns(db)).toContain('workspace_id');
    // The existing row keeps its data and picks up the default.
    expect(db.prepare('SELECT workspace_id FROM sessions WHERE key = ?').get('web-1')).toEqual({
      workspace_id: 'default',
    });
  });

  it('is idempotent — a second run applies nothing', () => {
    const db = legacyDatabase();
    migrate(db, 'sessions', [ADD_WORKSPACE]);
    // A repeated ALTER is a hard error in SQLite, so surviving this call at all
    // is the assertion; the version staying put is why it survives.
    migrate(db, 'sessions', [ADD_WORKSPACE]);
    expect(versionOf(db, 'sessions')).toBe(1);
  });

  it('applies only the unapplied tail when the list grows', () => {
    const db = legacyDatabase();
    migrate(db, 'sessions', [ADD_WORKSPACE]);
    migrate(db, 'sessions', [ADD_WORKSPACE, `ALTER TABLE sessions ADD COLUMN pinned INTEGER;`]);

    expect(columns(db)).toContain('pinned');
    expect(versionOf(db, 'sessions')).toBe(2);
  });

  it('namespaces by store, so two stores sharing a file do not read each other version', () => {
    const db = legacyDatabase();
    db.exec('CREATE TABLE notifications (id TEXT PRIMARY KEY) STRICT;');

    migrate(db, 'sessions', [ADD_WORKSPACE]);
    migrate(db, 'notifications', [`ALTER TABLE notifications ADD COLUMN read_at_ms INTEGER;`]);

    expect(versionOf(db, 'sessions')).toBe(1);
    expect(versionOf(db, 'notifications')).toBe(1);
    expect(columns(db)).toContain('workspace_id');
  });

  it('rolls back and leaves the version untouched when a migration fails', () => {
    const db = legacyDatabase();
    migrate(db, 'sessions', [ADD_WORKSPACE]);

    try {
      migrate(db, 'sessions', [
        ADD_WORKSPACE,
        `ALTER TABLE sessions ADD COLUMN good INTEGER;`,
        `ALTER TABLE nonexistent ADD COLUMN bad INTEGER;`,
      ]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(isGhostError(error) && error.kind).toBe('storage');
    }

    // Neither the half-applied column nor the new version survives, so the next
    // boot retries from exactly where this one started.
    expect(columns(db)).not.toContain('good');
    expect(versionOf(db, 'sessions')).toBe(1);
  });

  it('runs the whole list against a database that has never been migrated', () => {
    const db = legacyDatabase();
    migrate(db, 'sessions', [ADD_WORKSPACE, `ALTER TABLE sessions ADD COLUMN pinned INTEGER;`]);
    expect(columns(db)).toEqual(expect.arrayContaining(['workspace_id', 'pinned']));
    expect(versionOf(db, 'sessions')).toBe(2);
  });

  it('does nothing for an empty migration list', () => {
    const db = legacyDatabase();
    migrate(db, 'sessions', []);
    expect(versionOf(db, 'sessions')).toBeUndefined();
  });
});
