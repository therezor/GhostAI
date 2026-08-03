import { describe, expect, it } from 'vitest';

import {
  arrayField,
  asArray,
  asNumber,
  asRecord,
  asString,
  numberField,
  parseJson,
  recordField,
  stringField,
} from '#src/json.js';

describe('narrowing helpers', () => {
  it('separates records from the things that look like them', () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeNull();
    expect(asRecord(null)).toBeNull();
    expect(asRecord('{}')).toBeNull();
  });

  it('separates arrays from records', () => {
    expect(asArray([1])).toEqual([1]);
    expect(asArray({ length: 1 })).toBeNull();
  });

  it('rejects a number that is not a number', () => {
    // `NaN` survives arithmetic silently and only surfaces once a usage total
    // reaches the database.
    expect(asNumber(5)).toBe(5);
    expect(asNumber(0)).toBe(0);
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(asNumber('5')).toBeUndefined();
  });

  it('reads strings only when they are strings', () => {
    expect(asString('x')).toBe('x');
    expect(asString(5)).toBeUndefined();
  });

  it('reads fields without assuming the parent exists', () => {
    const record = { name: 'x', count: 2, nested: { deep: 'y' }, list: [1] };
    expect(stringField(record, 'name')).toBe('x');
    expect(numberField(record, 'count')).toBe(2);
    expect(recordField(record, 'nested')).toEqual({ deep: 'y' });
    expect(arrayField(record, 'list')).toEqual([1]);

    expect(stringField(null, 'name')).toBeUndefined();
    expect(numberField(null, 'count')).toBeUndefined();
    expect(recordField(null, 'nested')).toBeNull();
    expect(arrayField(null, 'list')).toBeNull();
    expect(recordField(record, 'missing')).toBeNull();
  });
});

describe('parseJson', () => {
  it('parses valid JSON and swallows the rest', () => {
    expect(parseJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseJson('null')).toBeNull();
    expect(parseJson('not json')).toBeUndefined();
    expect(parseJson('')).toBeUndefined();
  });
});
