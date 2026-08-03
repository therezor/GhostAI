/**
 * The generated document, validated as OpenAPI 3.1 rather than eyeballed.
 *
 * A hand-checked assertion that the JSON "looks right" is how a document starts
 * lying: the shapes it gets wrong are the ones nobody thought to assert. This
 * runs a real 3.1 validator over the whole thing, and then checks the two
 * properties a validator cannot know about — that every manifest route is in it,
 * and that every `$ref` points at a schema the pool actually holds.
 */

import { validate } from '@readme/openapi-parser';
import { afterEach, describe, expect, it } from 'vitest';

import { ROUTE_MANIFEST } from '#src/manifest.js';
import { startTestServer, type TestServer } from '#testkit/server.js';

const running: TestServer[] = [];

afterEach(async () => {
  while (running.length > 0) await running.pop()?.close();
});

interface Document {
  readonly openapi: string;
  readonly paths: Record<string, Record<string, { operationId?: string; responses?: unknown }>>;
  readonly components: { schemas: Record<string, unknown> };
}

async function document(): Promise<Document> {
  const test = await startTestServer();
  running.push(test);
  const response = await test.server.app.inject({
    method: 'GET',
    url: '/api/openapi.json',
    headers: test.headers,
  });
  return response.json<Document>();
}

/** Fastify's `:key` is OpenAPI's `{key}`. */
function documentPath(url: string): string {
  return url.replaceAll(/:(\w+)/g, '{$1}');
}

function refsIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, found);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') found.push(item);
      else refsIn(item, found);
    }
  }
  return found;
}

describe('the generated document', () => {
  it('validates as OpenAPI 3.1', async () => {
    const doc = await document();

    // The validator mutates and dereferences what it is given, so it gets a
    // copy — a later assertion reading `$ref`s from a dereferenced document
    // would find none and pass for the wrong reason.
    const result = await validate(
      structuredClone(doc) as unknown as Parameters<typeof validate>[0],
    );

    // The failure branch carries the errors; asserting on them first means a
    // failing run names what is wrong instead of only saying `false !== true`.
    if (!result.valid) expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(doc.openapi).toBe('3.1.0');
  });

  it('describes every manifest route exactly once', async () => {
    const doc = await document();

    const operations = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((operation) => operation.operationId),
    );

    expect(operations.filter((id) => id !== undefined).sort()).toEqual(
      ROUTE_MANIFEST.map((spec) => spec.id).sort(),
    );
    for (const spec of ROUTE_MANIFEST) {
      expect(doc.paths[documentPath(spec.url)]?.[spec.method.toLowerCase()]).toBeDefined();
    }
  });

  it('resolves every reference against the component pool', async () => {
    const doc = await document();
    const names = new Set(Object.keys(doc.components.schemas));

    const dangling = refsIn(doc.paths).filter(
      (ref) => !names.has(ref.replace('#/components/schemas/', '')),
    );
    expect(dangling).toEqual([]);
  });

  it('documents a query parameter the route actually enforces', async () => {
    const doc = await document();
    const operation = doc.paths['/api/sessions']?.get as unknown as {
      parameters: { name: string; schema: Record<string, unknown> }[];
    };

    const limit = operation.parameters.find((parameter) => parameter.name === 'limit');
    // Coerced from a string at the door, and documented as the integer it
    // becomes — with the cap, so a client knows before it is refused.
    expect(limit?.schema).toMatchObject({ type: 'integer', maximum: 200, default: 50 });
  });
});
