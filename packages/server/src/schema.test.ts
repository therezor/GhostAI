import {
  LoginRequestSchema,
  LoginResponseSchema,
  PROTOCOL_SCHEMAS,
  type ConfigPatch,
} from '@ghostai/protocol';
import type { FastifySchema } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  PROTOCOL_COMPONENTS,
  componentRef,
  jsonSchemaTransform,
  jsonSerializerCompiler,
  zodValidatorCompiler,
} from './schema.js';

function transform(schema: FastifySchema): Record<string, unknown> {
  return jsonSchemaTransform({ schema, url: '/api/test' }).schema;
}

function validate(schema: z.ZodType, data: unknown, httpPart = 'body'): unknown {
  return zodValidatorCompiler({
    schema,
    method: 'POST',
    url: '/api/test',
    httpStatus: '200',
    httpPart,
  })(data);
}

describe('the component pool', () => {
  it('carries every registered protocol schema', () => {
    expect(Object.keys(PROTOCOL_COMPONENTS).sort()).toEqual(Object.keys(PROTOCOL_SCHEMAS).sort());
  });

  // `$schema` belongs at the root of a document, not on each member of a pool.
  it('strips the dialect marker from each entry', () => {
    for (const value of Object.values(PROTOCOL_COMPONENTS)) {
      expect(value).not.toHaveProperty('$schema');
    }
  });

  it('emits a pointer into the pool', () => {
    expect(componentRef('LoginResponse')).toEqual({
      $ref: '#/components/schemas/LoginResponse',
    });
  });
});

describe('jsonSchemaTransform', () => {
  it('is a no-op for a route with no schema', () => {
    expect(jsonSchemaTransform({ url: '/api/test' })).toEqual({ schema: {}, url: '/api/test' });
  });

  it('references the pool for a registered response schema', () => {
    expect(transform({ response: { 200: LoginResponseSchema } })).toEqual({
      response: { '200': { $ref: '#/components/schemas/LoginResponse' } },
    });
  });

  // Output mode marks every field carrying a `.default()` as required, because
  // by then the parse has supplied it — advertising that to a client tells it to
  // send values the schema exists to fill in, and it obliges.
  it('inlines a request body in input mode', () => {
    const body = transform({ body: LoginRequestSchema }).body as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'object', required: ['username', 'password'] });
    expect(body).not.toHaveProperty('$ref');
  });

  it('inlines a schema that is not in the pool', () => {
    const local = z.object({ page: z.number() });
    expect(transform({ querystring: local }).querystring).toMatchObject({ type: 'object' });
  });

  it('converts params and leaves unrelated keys alone', () => {
    const out = transform({
      params: z.object({ key: z.string() }),
      summary: 'a route',
      operationId: 'test.route',
    });

    expect(out.summary).toBe('a route');
    expect(out.operationId).toBe('test.route');
    expect(out.params).toMatchObject({ type: 'object' });
  });

  it('passes a response entry that is already JSON Schema straight through', () => {
    const raw = { type: 'string' };
    expect(transform({ response: { 200: raw } }).response).toEqual({ '200': raw });
  });
});

describe('zodValidatorCompiler', () => {
  it('returns the parsed value, not the input', () => {
    // `ConfigPatch` is the case that matters: deep-partial, so parsing must not
    // put every default back into a patch that never mentioned them.
    const result = validate(PROTOCOL_SCHEMAS.ConfigPatch, {
      agents: { defaults: { temperature: 0.5 } },
    }) as { value: ConfigPatch };

    expect(result.value).toEqual({ agents: { defaults: { temperature: 0.5 } } });
  });

  it('reports a failure as a 422 keyed by JSON pointer', () => {
    const result = validate(LoginRequestSchema, { username: 'ghost', password: 42 }) as {
      error: { status: number; code: string; details: Record<string, string> };
    };

    expect(result.error.status).toBe(422);
    expect(result.error.code).toBe('bad_request');
    expect(Object.keys(result.error.details)).toEqual(['/password']);
  });

  it('points at a nested field with a full pointer', () => {
    const schema = z.object({ outer: z.object({ inner: z.string() }) });
    const result = validate(schema, { outer: { inner: 1 } }) as {
      error: { details: Record<string, string> };
    };

    expect(Object.keys(result.error.details)).toEqual(['/outer/inner']);
  });

  it('uses `/` for a failure at the root', () => {
    const result = validate(z.string(), 42) as { error: { details: Record<string, string> } };
    expect(Object.keys(result.error.details)).toEqual(['/']);
  });

  it('names the part that failed', () => {
    const result = validate(LoginRequestSchema, {}, 'querystring') as {
      error: { message: string };
    };
    expect(result.error.message).toBe('Invalid querystring');
  });

  it('falls back to naming the request when Fastify does not say', () => {
    const compile = zodValidatorCompiler({
      schema: LoginRequestSchema,
      method: 'POST',
      url: '/api/test',
      httpStatus: '200',
    });
    expect((compile({}) as { error: { message: string } }).error.message).toBe('Invalid request');
  });

  it('keeps only the first issue per field', () => {
    const schema = z.object({ name: z.string().min(5).startsWith('x') });
    const result = validate(schema, { name: 'a' }) as {
      error: { details: Record<string, string> };
    };

    expect(Object.keys(result.error.details)).toEqual(['/name']);
  });
});

describe('jsonSerializerCompiler', () => {
  it('serialises without filtering by schema', () => {
    // Stated as a test because it is a property worth being deliberate about:
    // nothing relies on serialisation to keep a field out of a response.
    expect(jsonSerializerCompiler()({ a: 1, extra: true })).toBe('{"a":1,"extra":true}');
  });
});
