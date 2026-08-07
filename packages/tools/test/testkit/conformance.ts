/**
 * The tool conformance suite.
 *
 * Every tool — built-in, extension-supplied, or proxied from an MCP server — has to
 * behave the same way at its edges, and those edges are where tools break in
 * ways that look like the *model* being broken. A schema that advertises a
 * required field it does not need produces hallucinated arguments; a tool that
 * strips an unknown key answers a question nobody asked; one that ignores its
 * signal turns the Stop button into a suggestion. None of that shows up in a
 * test of the tool's happy path, so it is checked here, once, for all of them.
 *
 * The suite is generated from the tool's own JSON Schema wherever it can be:
 * the coercion and wrong-type cases are derived by walking `parameters`, so a
 * tool that gains a numeric argument gains its coercion test without anyone
 * remembering to write one.
 *
 * It is reachable from other packages as `@ghostai/tools/testkit`, because two
 * of the three kinds of tool above are defined elsewhere — `@ghostai/mcp` is the
 * first — and a contract only verifiable from inside this package would go
 * unverified exactly where it matters. It stays off the package *entry* all the
 * same: this file imports `vitest`, and the entry is in the runtime dependency
 * graph of everything downstream.
 */

import { describe, expect, it } from 'vitest';

import { isAbortError, isGhostError } from '@ghostai/core';

import type { AnyTool, ToolContext } from '#src/define.js';
import { TOOL_NAME_PATTERN } from '#src/define.js';
import { ToolRegistry } from '#src/registry.js';

export interface ToolConformanceOptions {
  readonly tool: AnyTool;
  /**
   * A fresh context per test — normally a new temporary workspace. Called once
   * per case, so nothing a case writes can leak into the next.
   */
  readonly context: () => ToolContext;
  /** Arguments the tool accepts and can execute against `context()`. */
  readonly validArgs: Readonly<Record<string, unknown>>;
  /**
   * Arguments producing more output than `config.maxOutputChars`. Omit only if
   * the tool cannot be made to produce a large result.
   */
  readonly largeOutputArgs?: Readonly<Record<string, unknown>>;
}

interface Property {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly minimum: number | undefined;
}

function readProperties(
  parameters: Readonly<Record<string, unknown>>,
): readonly Property[] {
  const properties = (parameters.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set((parameters.required ?? []) as readonly string[]);
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: typeof schema.type === 'string' ? schema.type : 'unknown',
    required: required.has(name),
    minimum: typeof schema.minimum === 'number' ? schema.minimum : undefined,
  }));
}

/** A key no schema declares, used to prove unknown arguments are refused. */
const UNKNOWN_KEY = '__ghostai_conformance_unknown__';

export function toolConformance(options: ToolConformanceOptions): void {
  const { tool } = options;
  const properties = readProperties(tool.parameters);

  describe(`tool conformance: ${tool.name}`, () => {
    describe('declaration', () => {
      it('has a provider-safe name and a description', () => {
        expect(tool.name).toMatch(TOOL_NAME_PATTERN);
        expect(tool.description.trim().length).toBeGreaterThan(0);
      });

      it('advertises an object schema that rejects unknown properties', () => {
        expect(tool.parameters.type).toBe('object');
        expect(tool.parameters.additionalProperties).toBe(false);
        expect(tool.parameters.$schema).toBeUndefined();
      });

      it('round-trips through JSON unchanged', () => {
        // The definitions go over the wire to a provider and over the
        // WebSocket to the UI. Anything not JSON-representable — a Date, a
        // RegExp, undefined — silently changes shape in transit.
        expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(
          tool.parameters,
        );
      });

      it('describes every property it advertises', () => {
        const described = (tool.parameters.properties ?? {}) as Record<
          string,
          Record<string, unknown>
        >;
        for (const [name, schema] of Object.entries(described)) {
          expect(
            schema.description,
            `${tool.name}.${name} has no description`,
          ).toBeTruthy();
        }
      });

      it('reports a definition carrying its source', () => {
        expect(tool.definition('extension')).toMatchObject({
          name: tool.name,
          source: 'extension',
          risk: tool.risk,
          parameters: tool.parameters,
        });
      });
    });

    describe('argument validation', () => {
      it('accepts its valid arguments', () => {
        const parsed = tool.parseArgs(options.validArgs);
        expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
      });

      it.each([
        ['a string', 'not an object'],
        ['a number', 42],
        ['an array', []],
        ['a boolean', true],
      ])('rejects %s in place of an argument object', (label, raw) => {
        expect(tool.parseArgs(raw).ok).toBe(false);
      });

      it('rejects an unknown property rather than stripping it', () => {
        const parsed = tool.parseArgs({
          ...options.validArgs,
          [UNKNOWN_KEY]: true,
        });
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) expect(parsed.message).toContain(tool.name);
      });

      const requiredProperties = properties.filter(
        (property) => property.required,
      );
      if (requiredProperties.length > 0) {
        it.each(requiredProperties.map((property) => [property.name] as const))(
          'rejects a call missing the required %s',
          (name) => {
            const { [name]: omitted, ...rest } = options.validArgs;
            expect(tool.parseArgs(rest).ok).toBe(false);
          },
        );
      }

      const numeric = properties.filter(
        (property) => property.type === 'integer' || property.type === 'number',
      );
      if (numeric.length > 0) {
        it.each(
          numeric.map(
            (property) => [property.name, property.minimum ?? 1] as const,
          ),
        )(
          'coerces the string form of %s, as models emit it',
          (name, minimum) => {
            const parsed = tool.parseArgs({
              ...options.validArgs,
              [name]: String(minimum),
            });
            expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
            if (parsed.ok) {
              expect((parsed.args as Record<string, unknown>)[name]).toBe(
                minimum,
              );
            }
          },
        );
      }

      const strings = properties.filter(
        (property) => property.type === 'string',
      );
      if (strings.length > 0) {
        it.each(strings.map((property) => [property.name] as const))(
          'rejects a number where %s expects a string',
          (name) => {
            expect(tool.parseArgs({ ...options.validArgs, [name]: 1 }).ok).toBe(
              false,
            );
          },
        );
      }
    });

    describe('execution', () => {
      it('honours an already-aborted signal within 100 ms', async () => {
        const base = options.context();
        const started = performance.now();
        const failure = await tool
          .run(options.validArgs, { ...base, signal: AbortSignal.abort() })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(performance.now() - started).toBeLessThan(100);
        expect(failure).not.toBeNull();
        expect(isAbortError(failure)).toBe(true);
      });

      it('reports a failure as a typed error, never a message prefix', async () => {
        const base = options.context();
        // Every tool takes at least one argument that can be made invalid;
        // an unknown key is the one case guaranteed to exist for all of them.
        const failure = await tool
          .run({ ...options.validArgs, [UNKNOWN_KEY]: true }, base)
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(isGhostError(failure)).toBe(true);
      });

      if (options.largeOutputArgs !== undefined) {
        const largeArgs = options.largeOutputArgs;
        it('respects maxOutputChars', async () => {
          const base = options.context();
          const registry = new ToolRegistry();
          registry.register(tool);
          const config = { ...base.config, maxOutputChars: 200 };
          const execution = await registry.execute(
            { name: tool.name, argumentsJson: JSON.stringify(largeArgs) },
            { ...base, config },
          );
          expect(execution.isError, execution.content).toBe(false);
          expect(execution.truncated).toBe(true);
          // The truncation marker names how much was dropped, so the result is
          // the budget plus that one line rather than exactly the budget.
          expect(execution.content.length).toBeLessThan(
            config.maxOutputChars + 200,
          );
        });
      }
    });
  });
}
