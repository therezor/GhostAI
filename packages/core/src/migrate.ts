/**
 * Schema migrations, namespaced per store.
 *
 * Everything in GhostAI's database is created with `CREATE TABLE IF NOT EXISTS`
 * by the store that owns it, which is enough right up until a column has to be
 * added to a table that already has rows in the field. This is that mechanism,
 * and it is deliberately the smallest one that works.
 *
 * **Why not `PRAGMA user_version`.** It is one integer per *file*, and three
 * stores share this file: `SessionStore` in this package, `AuthStore` and
 * `NotificationStore` in `@ghostai/server`. They construct in an order nothing
 * guarantees, each creating its own tables. A single counter would either be
 * owned by whichever store ran first — a race — or force one package to know
 * about another's schema. A `schema_versions` row per store namespace costs one
 * tiny table and removes the coupling entirely.
 *
 * **Why the whole tail runs in one transaction.** A migration that fails partway
 * leaves the database in a state no version number describes, and the next boot
 * would then re-run statements that already applied. Rolling back and leaving
 * the recorded version untouched means a failed upgrade is a startup error
 * against an unchanged database, which is recoverable; a half-applied one is
 * not.
 *
 * **`CREATE TABLE IF NOT EXISTS` stays where it is.** A store still creates its
 * own tables; this is only for altering what already exists. That means a fresh
 * database runs the `ALTER` at version 0 exactly as an existing one does, so
 * there is one code path rather than a "new install" path nobody exercises.
 */

import type { DatabaseSync } from 'node:sqlite';

import { GhostError } from './errors.js';

const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_versions (
  name    TEXT    PRIMARY KEY,
  version INTEGER NOT NULL
) STRICT;
`;

/**
 * Applies the unapplied tail of one store's migration list.
 *
 * `migrations` is append-only and its length is the version: index 0 is the
 * first migration, and a database at version `n` has applied the first `n`.
 * Editing an entry that has already shipped changes nothing on an existing
 * install and everything on a fresh one, so don't — append instead.
 */
export function migrate(db: DatabaseSync, name: string, migrations: readonly string[]): void {
  db.exec(LEDGER);

  const row = db.prepare('SELECT version FROM schema_versions WHERE name = ?').get(name) as
    { readonly version: number } | undefined;
  const current = row?.version ?? 0;
  if (current >= migrations.length) return;

  db.exec('BEGIN');
  try {
    for (const statement of migrations.slice(current)) db.exec(statement);
    db.prepare(
      `INSERT INTO schema_versions (name, version) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET version = excluded.version`,
    ).run(name, migrations.length);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw new GhostError('storage', `Migration ${String(current)} for "${name}" failed`, {
      cause: error,
      details: { name, from: current, to: migrations.length },
    });
  }
}
