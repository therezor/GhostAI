/**
 * Reading typed values out of a `node:sqlite` row.
 *
 * Every table in this codebase is `STRICT`, so a column that comes back the
 * wrong type means the row was written by something that bypassed the schema,
 * or the file is damaged. That is a `storage` error rather than a value to
 * paper over — a session whose `created_at_ms` reads as `0` because the column
 * held a string is worse than a read that says so, because it is indexed,
 * sorted and shown as fact.
 *
 * This lived four times over — in `SessionStore`, `WorkspaceStore`, the
 * automation store and the notification store — and the copies had already
 * drifted: three threw, and `WorkspaceStore`'s returned `''` and `0`. Nothing
 * marked the divergence, because four functions with the same name and the same
 * signature read as four copies of one decision. Where a store really does want
 * to tolerate a bad value, it now says so at the call site with `optional…()`
 * and a fallback, which is a sentence a reviewer can disagree with.
 *
 * `bigint` is accepted wherever an integer is: `node:sqlite` returns one for a
 * value outside the safe-integer range, and a row counter that has been running
 * for years is not a corrupt row.
 */

import type { SQLOutputValue } from 'node:sqlite';

import { GhostError } from './errors.js';

/** One row as `node:sqlite` hands it back. */
export type Row = Record<string, SQLOutputValue>;

/** The four readers, bound to the store whose rows they are reading. */
interface RowReader {
  /** An integer column. Throws `storage` when it is anything else. */
  int(row: Row, column: string): number;
  /** A text column. Throws `storage` when it is anything else. */
  string(row: Row, column: string): string;
  /**
   * An integer column that may be `NULL`.
   *
   * `SUM` over a column of all-`NULL` returns `NULL` rather than `0`, which is
   * exactly the distinction the optional usage fields carry: a provider that
   * never reported cached tokens is not a provider that reported zero.
   */
  optionalInt(row: Row, column: string): number | undefined;
  /** A text column that may be `NULL`, or absent from an older schema. */
  optionalString(row: Row, column: string): string | undefined;
}

function toInt(value: SQLOutputValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return undefined;
}

/**
 * Readers that name `store` when they fail.
 *
 * The store is carried in `details` rather than baked into the message so every
 * one of these errors reads the same way in a log, and so a handler can branch
 * on the store without parsing prose.
 */
export function rowReader(store: string): RowReader {
  return {
    int(row, column) {
      const value = toInt(row[column]);
      if (value !== undefined) return value;
      throw new GhostError(
        'storage',
        `Expected an integer in column "${column}"`,
        {
          details: { store, column },
        },
      );
    },
    string(row, column) {
      const value = row[column];
      if (typeof value === 'string') return value;
      throw new GhostError('storage', `Expected text in column "${column}"`, {
        details: { store, column },
      });
    },
    optionalInt(row, column) {
      return toInt(row[column]);
    },
    optionalString(row, column) {
      const value = row[column];
      return typeof value === 'string' ? value : undefined;
    },
  };
}

/**
 * A JSON object column, as a bag.
 *
 * Metadata is written by channels and extensions, so a malformed value is a bug
 * in something else. Failing the whole read over it would make one bad extension
 * write cost the user their conversation; an empty bag loses only the metadata.
 * That makes this the one column where tolerance is the right answer, and it is
 * why this is a separate function rather than another `RowReader` method — the
 * readers throw, and this deliberately does not.
 */
export function parseMetadata(raw: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
