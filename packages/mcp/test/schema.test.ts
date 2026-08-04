import { isGhostError } from '@ghostai/core';
import { describe, expect, it } from 'vitest';

import { compileValidator, normaliseSchema } from '#src/schema.js';

const WELL_FORMED = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'What to repeat.' },
    times: { type: 'integer', minimum: 1, description: 'How many times.' },
  },
  required: ['text'],
  additionalProperties: false,
};

describe('normaliseSchema', () => {
  it('passes a well-formed schema through with no issues', () => {
    const { parameters, issues } = normaliseSchema('echo', WELL_FORMED);
    expect(issues).toEqual([]);
    expect(parameters).toEqual(WELL_FORMED);
  });

  it('strips $schema, which providers take as a parameter object', () => {
    const { parameters } = normaliseSchema('echo', {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...WELL_FORMED,
    });
    expect(parameters.$schema).toBeUndefined();
  });

  it('seals a schema that said nothing about extra keys', () => {
    // Most servers simply omit it, and this repo's position is that a model
    // adding an undeclared key has misunderstood the tool.
    const { parameters } = normaliseSchema('echo', {
      type: 'object',
      properties: { text: { type: 'string', description: 'x' } },
    });
    expect(parameters.additionalProperties).toBe(false);
  });

  it('leaves an explicitly open schema open, and says so', () => {
    // A tool that genuinely takes a free-form bag exists, and refusing to
    // advertise it would be this client overruling the server about its own
    // arguments.
    const { parameters, issues } = normaliseSchema('anything', {
      type: 'object',
      properties: {},
      additionalProperties: true,
    });
    expect(parameters.additionalProperties).toBe(true);
    expect(issues[0]?.message).toContain('undeclared arguments');
  });

  it('reports an undescribed argument rather than inventing a description', () => {
    const { issues } = normaliseSchema('echo', {
      type: 'object',
      properties: { text: { type: 'string' } },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('no description');
  });

  it('freezes and JSON round-trips, because the object travels', () => {
    const { parameters } = normaliseSchema('echo', WELL_FORMED);
    expect(Object.isFrozen(parameters)).toBe(true);
    expect(JSON.parse(JSON.stringify(parameters))).toEqual(parameters);
  });

  it('severs the object the server sent', () => {
    const source = {
      ...WELL_FORMED,
      properties: { ...WELL_FORMED.properties },
    };
    const { parameters } = normaliseSchema('echo', source);
    expect(parameters.properties).not.toBe(source.properties);
  });

  it('refuses a schema that is not an object schema', () => {
    for (const raw of [undefined, null, 'nope', { type: 'string' }, []]) {
      expect(() => normaliseSchema('echo', raw)).toThrow();
    }
    try {
      normaliseSchema('echo', { type: 'string' });
    } catch (error) {
      expect(isGhostError(error)).toBe(true);
    }
  });
});

describe('compileValidator', () => {
  const { parameters } = normaliseSchema('echo', WELL_FORMED);
  const validate = compileValidator('mcp_x_echo', parameters);

  it('accepts a valid call', () => {
    const parsed = validate({ text: 'hi', times: 2 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args).toEqual({ text: 'hi', times: 2 });
  });

  it('treats an absent argument object as an empty one', () => {
    // A model calling a no-argument tool emits nothing at all; the schema's own
    // `required` list is the right thing to judge that.
    const optional = compileValidator(
      'mcp_x_ping',
      normaliseSchema('ping', { type: 'object', properties: {} }).parameters,
    );
    expect(optional(undefined).ok).toBe(true);
    expect(optional(null).ok).toBe(true);
  });

  it.each([
    ['a string', 'nope'],
    ['a number', 42],
    ['an array', []],
    ['a boolean', true],
  ])('refuses %s in place of an argument object', (label, raw) => {
    expect(validate(raw).ok).toBe(false);
  });

  it('refuses an unknown argument rather than stripping it', () => {
    const parsed = validate({ text: 'hi', nope: 1 });
    expect(parsed.ok).toBe(false);
    // The message names the tool, so a model reading it knows which call failed.
    if (!parsed.ok) expect(parsed.message).toContain('mcp_x_echo');
  });

  it('keeps an unknown argument when the server said it accepts them', () => {
    const open = compileValidator(
      'mcp_x_anything',
      normaliseSchema('anything', {
        type: 'object',
        properties: {},
        additionalProperties: true,
      }).parameters,
    );
    const parsed = open({ whatever: 1 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args).toEqual({ whatever: 1 });
  });

  it('refuses a call missing a required argument', () => {
    expect(validate({ times: 1 }).ok).toBe(false);
  });

  it('coerces the string form of a number, as models emit it', () => {
    const parsed = validate({ text: 'hi', times: '3' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.args.times).toBe(3);
  });

  it('does not coerce a fractional string into an integer', () => {
    expect(validate({ text: 'hi', times: '1.5' }).ok).toBe(false);
  });

  it('does not coerce in the other direction', () => {
    // A number where a string was asked for is a model that has misunderstood
    // the tool, and quietly stringifying it would hide that.
    expect(validate({ text: 1 }).ok).toBe(false);
  });

  it('honours an enum', () => {
    const validateEnum = compileValidator(
      'mcp_x_pick',
      normaliseSchema('pick', {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['a', 'b'], description: 'Which.' },
        },
      }).parameters,
    );
    expect(validateEnum({ mode: 'a' }).ok).toBe(true);
    const refused = validateEnum({ mode: 'c' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.message).toContain('must be one of');
  });

  it('accepts a union of declared types', () => {
    const validateUnion = compileValidator(
      'mcp_x_either',
      normaliseSchema('either', {
        type: 'object',
        properties: {
          value: { type: ['string', 'number'], description: 'Either.' },
        },
      }).parameters,
    );
    expect(validateUnion({ value: 'a' }).ok).toBe(true);
    expect(validateUnion({ value: 1 }).ok).toBe(true);
    expect(validateUnion({ value: true }).ok).toBe(false);
  });

  it('passes through a type it does not model, which the server judges', () => {
    // One level, then stop: re-implementing JSON Schema would be a second
    // validator to keep in step with a spec nobody here owns.
    const validateNested = compileValidator(
      'mcp_x_nested',
      normaliseSchema('nested', {
        type: 'object',
        properties: {
          filter: {
            type: 'object',
            description: 'Whatever the server means by this.',
          },
        },
      }).parameters,
    );
    expect(validateNested({ filter: { deeply: { nested: true } } }).ok).toBe(
      true,
    );
  });

  it('reports every problem at once, not just the first', () => {
    const parsed = validate({ text: 1, nope: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.length).toBe(2);
  });
});
