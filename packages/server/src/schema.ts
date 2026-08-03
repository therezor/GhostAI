/**
 * One schema per thing, two artifacts from it.
 *
 * A route declares its body, query and responses as the Zod schemas
 * `@ghostai/protocol` already exports. Those same objects are what validates a
 * request and what `@fastify/swagger` turns into the OpenAPI document, so the
 * reference cannot describe a shape the server does not enforce — the drift
 * that makes a hand-maintained API document worse than none.
 *
 * Fastify's own AJV is replaced rather than fed. `z.toJSONSchema` emits
 * draft 2020-12, AJV compiles draft-07 by default, and reconciling the two
 * would mean generating JSON Schema, compiling it, and then *still* not getting
 * Zod's coercion. Validating with Zod directly and handing AJV nothing is both
 * simpler and the only version where the document and the check share a source.
 *
 * `PROTOCOL_COMPONENTS` is the `$defs` pool the plan calls for: every schema in
 * `PROTOCOL_SCHEMAS`, converted once, published under `components.schemas`. A
 * route whose response *is* a registered protocol schema emits a `$ref` to it;
 * anything else inlines. Request bodies always inline, in input mode — the
 * difference matters, because output mode lists every field carrying a
 * `.default()` as required, which would tell a client it must send values the
 * schema exists to supply.
 */

import { PROTOCOL_SCHEMAS } from '@ghostai/protocol';
import type { FastifySchema, FastifySchemaCompiler } from 'fastify';
import { z } from 'zod';

import { unprocessable } from './errors.js';

type JsonSchema = Record<string, unknown>;

/** `$schema` is meaningful at the root of a document and noise inside `components`. */
function convert(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: dialect, ...rest } = z.toJSONSchema(schema, {
    io,
  }) as JsonSchema & {
    $schema?: unknown;
  };
  return rest;
}

function buildComponents(): Readonly<Record<string, JsonSchema>> {
  const out: Record<string, JsonSchema> = {};
  for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) {
    out[name] = convert(schema, 'output');
  }
  return out;
}

/** The `$defs` pool. Every protocol schema, converted once at module load. */
export const PROTOCOL_COMPONENTS: Readonly<Record<string, JsonSchema>> =
  buildComponents();

/**
 * Identity, not structure.
 *
 * Two schemas can convert to the same JSON and still be different types; what
 * decides whether a response is "the protocol's `LoginResponse`" is whether the
 * route referenced that exact object.
 */
const NAMES_BY_SCHEMA = new Map<unknown, string>(
  Object.entries(PROTOCOL_SCHEMAS).map(([name, schema]) => [schema, name]),
);

export function componentRef(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

function refOrInline(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const name = NAMES_BY_SCHEMA.get(schema);
  // Input mode never refs: the pool is output-shaped, and a request body that
  // pointed at it would advertise defaulted fields as required.
  if (name !== undefined && io === 'output') return componentRef(name);
  return convert(schema, io);
}

function isZodType(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

/**
 * Turns the Zod schemas on a route into the JSON Schema the document shows.
 *
 * Passed to `@fastify/swagger` as its `transform`, so conversion happens once,
 * when the document is first generated, rather than on every request.
 */
export function jsonSchemaTransform({
  schema,
  url,
}: {
  schema?: FastifySchema;
  url: string;
}): {
  schema: JsonSchema;
  url: string;
} {
  if (schema === undefined) return { schema: {}, url };

  const { body, querystring, params, response, ...rest } =
    schema as FastifySchema & {
      response?: Record<string, unknown>;
    };
  const out: JsonSchema = { ...rest };

  if (isZodType(body)) out.body = refOrInline(body, 'input');
  if (isZodType(querystring)) {
    out.querystring = refOrInline(querystring, 'input');
  }
  if (isZodType(params)) out.params = refOrInline(params, 'input');

  if (response !== undefined) {
    const responses: JsonSchema = {};
    for (const [status, value] of Object.entries(response)) {
      responses[status] = isZodType(value)
        ? refOrInline(value, 'output')
        : value;
    }
    out.response = responses;
  }

  return { schema: out, url };
}

/** JSON pointer → message, which is what `ErrorResponse.details` is keyed by. */
function detailsOf(error: z.ZodError): Record<string, string> {
  const details: Record<string, string> = {};
  for (const issue of error.issues) {
    const pointer = issue.path.length === 0 ? '/' : `/${issue.path.join('/')}`;
    details[pointer] ??= issue.message;
  }
  return details;
}

/**
 * Validates with Zod and reports a 422 with field-level detail.
 *
 * Fastify uses an `Error` returned from here as-is, so the `HttpError` reaches
 * the error handler with its own status and code intact rather than being
 * rewritten into a bare 400.
 */
export const zodValidatorCompiler: FastifySchemaCompiler<z.ZodType> = ({
  schema,
  httpPart,
}) => {
  return (data: unknown) => {
    const result = schema.safeParse(data);
    if (result.success) return { value: result.data };
    return {
      error: unprocessable(
        `Invalid ${httpPart ?? 'request'}`,
        detailsOf(result.error),
      ),
    };
  };
};

/**
 * Plain `JSON.stringify`, because the response schema is a Zod object.
 *
 * Fastify's default serializer compiles JSON Schema with `fast-json-stringify`
 * and would be handed a Zod instance instead. Serialising by schema also
 * *filters* — a field the schema omits is dropped — and that is a property
 * worth being explicit about not having: nothing here relies on serialisation
 * to keep a credential out of a response. The routes never put one in.
 */
export const jsonSerializerCompiler = (): ((data: unknown) => string) => {
  return (data: unknown) => JSON.stringify(data);
};
