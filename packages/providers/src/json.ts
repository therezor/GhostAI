/**
 * Narrowing helpers for JSON a provider sent us.
 *
 * A response body is `unknown`, and it stays `unknown` until something checks
 * it. The alternative — casting the parsed body to a hand-written interface —
 * type-checks perfectly and then throws `Cannot read properties of undefined`
 * the first time a provider omits a field the interface promised. That failure
 * lands mid-turn, in production, against whichever endpoint the operator
 * configured rather than the one that was tested.
 *
 * Zod would do this too, but not here: a schema per provider response shape is
 * a schema per provider quirk, and the wire formats are other people's, changing
 * on their schedule. These readers take the fields they understand and ignore
 * everything else, which is the behaviour a tolerant client wants anyway.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `NaN` and `Infinity` are rejected rather than passed through: they survive
 * arithmetic silently and only surface once a usage total reaches the database.
 */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Reads a nested field, returning `null` unless every level is an object. */
export function recordField(
  record: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return record === null ? null : asRecord(record[key]);
}

export function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  return record === null ? undefined : asString(record[key]);
}

export function numberField(
  record: Record<string, unknown> | null,
  key: string,
): number | undefined {
  return record === null ? undefined : asNumber(record[key]);
}

export function arrayField(
  record: Record<string, unknown> | null,
  key: string,
): readonly unknown[] | null {
  return record === null ? null : asArray(record[key]);
}

/** Parses JSON without throwing. `undefined` means "not JSON", never "null". */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
