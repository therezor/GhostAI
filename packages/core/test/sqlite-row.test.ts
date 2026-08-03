import { describe, expect, it } from 'vitest';

import { GhostError } from '#src/errors.js';
import { parseMetadata, rowReader, type Row } from '#src/sqlite-row.js';

const read = rowReader('sessions');

function kindOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof GhostError ? error.kind : 'not-a-ghost-error';
  }
}

describe('rowReader', () => {
  it('reads the types a STRICT table promises', () => {
    const row: Row = { key: 'web:1', created_at_ms: 42 };

    expect(read.string(row, 'key')).toBe('web:1');
    expect(read.int(row, 'created_at_ms')).toBe(42);
  });

  it('takes a bigint where an integer is wanted', () => {
    // `node:sqlite` hands back a bigint for a value outside the safe-integer
    // range. A counter that has been running for years is not a corrupt row.
    expect(read.int({ seq: 9_007_199_254_740_993n }, 'seq')).toBe(
      9_007_199_254_740_992,
    );
    expect(read.optionalInt({ seq: 7n }, 'seq')).toBe(7);
  });

  it('refuses a column of the wrong type rather than inventing a value', () => {
    // The whole point of the shared reader. `WorkspaceStore` used to return
    // `''` and `0` here, so a damaged row became a workspace named "" created
    // at the epoch — indexed, sorted and shown as fact.
    expect(
      kindOf(() => read.int({ created_at_ms: 'nope' }, 'created_at_ms')),
    ).toBe('storage');
    expect(kindOf(() => read.string({ key: 7 }, 'key'))).toBe('storage');
    expect(kindOf(() => read.int({}, 'missing'))).toBe('storage');
    expect(kindOf(() => read.string({ key: null }, 'key'))).toBe('storage');
  });

  it('names the store and the column it failed on', () => {
    try {
      rowReader('notifications').int({ level: 'info' }, 'level');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(GhostError);
      expect((error as GhostError).details).toMatchObject({
        store: 'notifications',
        column: 'level',
      });
    }
  });

  it('reads a nullable column as absent rather than as a zero', () => {
    // `SUM` over an all-`NULL` column returns `NULL`, and a provider that never
    // reported cached tokens is not one that reported zero.
    expect(
      read.optionalInt({ cached_tokens: null }, 'cached_tokens'),
    ).toBeUndefined();
    expect(read.optionalInt({}, 'cached_tokens')).toBeUndefined();
    expect(read.optionalInt({ cached_tokens: 0 }, 'cached_tokens')).toBe(0);
    expect(read.optionalString({ agent_id: null }, 'agent_id')).toBeUndefined();
    expect(read.optionalString({ agent_id: 'writer' }, 'agent_id')).toBe(
      'writer',
    );
  });
});

describe('parseMetadata', () => {
  it('reads an object bag', () => {
    expect(parseMetadata('{"a":1}')).toEqual({ a: 1 });
  });

  it('tolerates anything that is not an object', () => {
    // The one column where tolerance is right: metadata is written by channels
    // and plugins, so one bad write must not cost the user their conversation.
    for (const raw of ['not json', '[]', 'null', '7', '"text"', '']) {
      expect(parseMetadata(raw)).toEqual({});
    }
  });
});
