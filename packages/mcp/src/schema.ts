/**
 * A remote `inputSchema`, made into something this repo will advertise and
 * validate against.
 *
 * Every other tool in GhostAI is declared with one Zod object and has its JSON
 * Schema *derived* from it (`defineTool`). An MCP server hands over the JSON
 * Schema directly, so the derivation runs the other way, and the temptation is
 * to convert it back into Zod so `defineTool` can be reused. That would be
 * worse than it looks: every JSON-Schema-to-Zod converter is lossy on `$ref`,
 * `oneOf`, `patternProperties` and `format`, so the model would be told a shape
 * the server did not describe — and the call would then fail *at the server*,
 * which reads as the model being broken.
 *
 * So the schema is passed through, normalised, and validated by the small
 * checker below. What that checker covers is exactly the contract
 * `toolConformance` states, and no more:
 *
 *   an object, not a string · no unknown keys · required keys present ·
 *   declared types honoured · `"10"` accepted where a number is wanted
 *
 * **It is deliberately not a JSON Schema engine.** One level of properties,
 * then it stops and lets the server judge its own arguments — which it does
 * anyway, and which it is the authority on. Re-implementing draft 2020-12 here
 * would be a second validator to keep in step with a spec nobody in this repo
 * owns, and its disagreements with the real one would surface as tools that
 * refuse calls the server would have accepted.
 */

import { GhostError } from '@ghostai/core';
import type { ArgIssue, ParseArgsResult } from '@ghostai/tools';

/** A problem with what a server advertised. Never fatal on its own. */
export interface SchemaIssue {
  readonly tool: string;
  readonly message: string;
}

export interface NormalisedSchema {
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly issues: readonly SchemaIssue[];
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The advertised parameter schema for one remote tool.
 *
 * Throws only for a schema that cannot be advertised at all; everything else is
 * an issue the caller surfaces beside the server. A tool whose schema is merely
 * sloppy still works.
 */
export function normaliseSchema(
  toolName: string,
  raw: unknown,
): NormalisedSchema {
  const issues: SchemaIssue[] = [];

  if (!isJsonObject(raw)) {
    throw new GhostError(
      'invalid_input',
      `Tool ${toolName} advertises no input schema`,
      { details: { tool: toolName } },
    );
  }

  // Structured cloning through JSON does three jobs at once: it severs the
  // prototype of an object that arrived over a socket, it drops anything not
  // representable on the wire, and it is the property `toolConformance` asserts
  // — these definitions travel to a provider and to the browser, and a value
  // that changes shape in transit is a schema the model was never shown.
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(raw)) as unknown;
  } catch (error) {
    throw new GhostError(
      'invalid_input',
      `Tool ${toolName} advertises an input schema that is not JSON`,
      { cause: error, details: { tool: toolName } },
    );
  }
  if (!isJsonObject(cloned)) {
    throw new GhostError(
      'invalid_input',
      `Tool ${toolName} advertises no input schema`,
      { details: { tool: toolName } },
    );
  }

  // A document-level annotation. Providers take this object as a *parameter*
  // schema rather than a standalone document, and some gateways reject unknown
  // top-level keys outright.
  const { $schema: document, ...parameters } = cloned;

  if (parameters.type !== 'object') {
    throw new GhostError(
      'invalid_input',
      `Tool ${toolName} must take an object, not ${String(parameters.type)}`,
      { details: { tool: toolName } },
    );
  }

  if (parameters.additionalProperties === undefined) {
    // The repo's position, from `defineTool`: a model that adds a key the tool
    // does not declare has misunderstood the tool, and stripping the key
    // silently answers a question nobody asked. Most servers simply omit this,
    // so the default is where it lands.
    parameters.additionalProperties = false;
  } else if (parameters.additionalProperties !== false) {
    // Left as the server wrote it. A tool that genuinely takes a free-form bag
    // exists, and refusing to advertise it would be this client deciding the
    // server is wrong about its own arguments.
    issues.push({
      tool: toolName,
      message:
        'accepts undeclared arguments, so a mistyped argument name will not be refused',
    });
  }

  const properties = isJsonObject(parameters.properties)
    ? parameters.properties
    : {};
  for (const [name, schema] of Object.entries(properties)) {
    if (isJsonObject(schema) && typeof schema.description === 'string') {
      continue;
    }
    // Reported, never invented. A description this client made up is a sentence
    // the model will believe and the server never wrote.
    issues.push({
      tool: toolName,
      message: `argument "${name}" has no description, so the model is guessing what it is for`,
    });
  }

  return { parameters: Object.freeze(parameters), issues };
}

interface PropertyRule {
  readonly types: readonly string[];
  readonly enumValues: readonly unknown[] | undefined;
}

function readTypes(schema: unknown): readonly string[] {
  if (!isJsonObject(schema)) return [];
  const declared = schema.type;
  if (typeof declared === 'string') return [declared];
  if (Array.isArray(declared)) {
    return declared.filter((entry) => typeof entry === 'string');
  }
  return [];
}

function readRules(
  parameters: Readonly<Record<string, unknown>>,
): ReadonlyMap<string, PropertyRule> {
  const properties = isJsonObject(parameters.properties)
    ? parameters.properties
    : {};
  const rules = new Map<string, PropertyRule>();
  for (const [name, schema] of Object.entries(properties)) {
    rules.set(name, {
      types: readTypes(schema),
      enumValues:
        isJsonObject(schema) && Array.isArray(schema.enum)
          ? schema.enum
          : undefined,
    });
  }
  return rules;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isJsonObject(value);
    case 'null':
      return value === null;
    default:
      // A type this checker does not model is the server's business, not this
      // module's. Passing it through is how "one level, then stop" is spelled.
      return true;
  }
}

/**
 * `"10"` where a number was asked for.
 *
 * Models emit the string form often enough that refusing it is a self-inflicted
 * failure mode; `defineTool` coerces for the same reason, in the schema, once.
 * Only in the number direction: coercing `1` into `"1"` for a string argument
 * would hide a model that has genuinely misunderstood the tool.
 */
function coerce(types: readonly string[], value: unknown): unknown {
  if (typeof value !== 'string' || value.trim() === '') return value;
  const wantsInteger = types.includes('integer');
  if (!wantsInteger && !types.includes('number')) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  if (wantsInteger && !Number.isInteger(parsed)) return value;
  return parsed;
}

function describeTypes(types: readonly string[]): string {
  return types.length === 1 ? (types[0] ?? '') : types.join(' or ');
}

/**
 * A validator for one tool's advertised parameters.
 *
 * Built once per tool, at bridge time, so a turn making twenty calls does not
 * re-walk the schema twenty times.
 */
export function compileValidator(
  toolName: string,
  parameters: Readonly<Record<string, unknown>>,
): (raw: unknown) => ParseArgsResult<Record<string, unknown>> {
  const rules = readRules(parameters);
  const required = new Set(
    Array.isArray(parameters.required)
      ? parameters.required.filter((name) => typeof name === 'string')
      : [],
  );
  const sealed = parameters.additionalProperties === false;

  return (raw: unknown): ParseArgsResult<Record<string, unknown>> => {
    // A model calling a no-argument tool emits `""`, `"{}"` or nothing at all,
    // and the registry hands that through as `undefined`. The schema's own
    // `required` list is the right thing to judge it.
    const candidate = raw ?? {};
    const issues: ArgIssue[] = [];

    if (!isJsonObject(candidate)) {
      return fail(toolName, [
        {
          path: '',
          message: `expected an object of arguments, received ${Array.isArray(candidate) ? 'an array' : typeof candidate}`,
        },
      ]);
    }

    const args: Record<string, unknown> = {};

    for (const [name, value] of Object.entries(candidate)) {
      const rule = rules.get(name);
      if (rule === undefined) {
        if (sealed) {
          issues.push({
            path: name,
            message: 'is not an argument of this tool',
          });
          continue;
        }
        args[name] = value;
        continue;
      }

      const coerced = coerce(rule.types, value);
      if (
        rule.types.length > 0 &&
        !rule.types.some((type) => matchesType(type, coerced))
      ) {
        issues.push({
          path: name,
          message: `expected ${describeTypes(rule.types)}, received ${
            Array.isArray(coerced) ? 'array' : typeof coerced
          }`,
        });
        continue;
      }
      if (rule.enumValues !== undefined && !rule.enumValues.includes(coerced)) {
        issues.push({
          path: name,
          message: `must be one of ${rule.enumValues.map((entry) => JSON.stringify(entry)).join(', ')}`,
        });
        continue;
      }
      args[name] = coerced;
    }

    for (const name of required) {
      if (name in candidate) continue;
      issues.push({ path: name, message: 'is required' });
    }

    if (issues.length > 0) return fail(toolName, issues);
    return { ok: true, args };
  };
}

function fail(
  toolName: string,
  issues: readonly ArgIssue[],
): ParseArgsResult<Record<string, unknown>> {
  const detail = issues
    .map((issue) =>
      issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`,
    )
    .join('; ');
  return {
    ok: false,
    message: `Invalid arguments for ${toolName}: ${detail}`,
    issues,
  };
}
