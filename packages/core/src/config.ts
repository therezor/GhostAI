/**
 * Reading `config.json`.
 *
 * The schema in `@ghostai/protocol` deliberately contains no `.transform()`, so
 * that every field stays representable as JSON Schema for the OpenAPI document
 * and the parsed type is identical to the input type. That leaves one job for
 * load time, and this is it: find the file, turn its absence into defaults
 * rather than an error, and resolve the paths the config names.
 *
 * Three decisions worth stating:
 *
 *  - **A missing config file is the normal first run**, not a failure. Every
 *    field has a default and `ConfigSchema.parse({})` yields a complete tree, so
 *    `ghost chat --provider ollama --model qwen3` has to work on a machine that
 *    has never written a config. `fromFile` reports which happened, for the one
 *    caller that wants to say "no config found" in a diagnostic.
 *
 *  - **A malformed config file is a hard failure, and it names the keys.** The
 *    alternative — falling back to defaults on a parse error — silently ignores
 *    everything the operator wrote, and the first sign of it is an agent talking
 *    to the wrong provider. Zod's issues are flattened into dotted paths because
 *    `agents.defaults.temperature` is something you can search a file for, and
 *    `[ 'agents', 'defaults', 'temperature' ]` is not.
 *
 *  - **Paths are resolved twice, on purpose.** `configFile` lives under the root,
 *    so the root has to be resolved before the file can be read — but the file
 *    is what names the workspace. The second pass folds `agents.defaults.workspace`
 *    in, with an explicit caller-supplied workspace still winning over both.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ConfigSchema, type Config } from '@ghostai/protocol';

import { GhostError } from './errors.js';
import {
  ensureDir,
  resolveGhostPaths,
  type GhostPaths,
  type ResolveGhostPathsOptions,
} from './paths.js';

export interface LoadConfigOptions extends ResolveGhostPathsOptions {
  /** Overrides `<root>/config.json`. */
  readonly file?: string;
}

export interface LoadedConfig {
  readonly config: Config;
  /** With `workspace` folded in from the config, unless the caller named one. */
  readonly paths: GhostPaths;
  /** The file that was read, or would have been. */
  readonly file: string;
  /** `false` when no file existed and the schema's defaults were used. */
  readonly fromFile: boolean;
}

/** Only the two errno values that mean "there is no config file here". */
const ABSENT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);

function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Parses and validates config text.
 *
 * Separate from the file read so that a config arriving over the wire — the
 * settings panel's preview in Phase 2 — is validated by exactly the same code
 * that validates the file, rather than by a second implementation that drifts.
 */
export function parseConfig(text: string, file: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new GhostError('config', `${file} is not valid JSON: ${describeJsonError(error)}`, {
      cause: error,
      details: { file },
    });
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `  ${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`,
    );
    throw new GhostError('config', `${file} has invalid settings:\n${issues.join('\n')}`, {
      cause: result.error,
      details: { file, issues },
    });
  }
  return result.data;
}

function describeJsonError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes the settings tree back.
 *
 * The other half of `loadConfig`, and it lives here for the same reason: a
 * settings save from the UI and a config file written by hand have to be the
 * same file in the same shape, and two implementations of "what a config file
 * looks like" is one more than the format can survive.
 *
 * Three properties it holds:
 *
 *  - **It validates before it writes.** A patch that merged into something the
 *    schema rejects is a config the next boot refuses to load, and discovering
 *    that at the next restart is discovering it at the worst moment.
 *  - **The replacement is atomic.** A crash mid-write leaves the previous file
 *    intact rather than a truncated one — a half-written `config.json` is an
 *    install that will not start.
 *  - **Two spaces and a trailing newline**, because this file is edited by hand
 *    at least as often as it is written by a program, and a save from the UI
 *    should not reformat what an operator wrote.
 */
export function saveConfig(file: string, config: Config): Config {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new GhostError('config', `Refusing to write invalid settings to ${file}`, {
      cause: parsed.error,
      details: { file },
    });
  }

  ensureDir(dirname(file));
  // Same directory, so the rename is a rename and not a cross-device copy —
  // which is not atomic and is exactly what this is avoiding.
  const temporary = `${file}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    throw new GhostError('config', `${file} could not be written`, {
      cause: error,
      details: { file },
    });
  }
  return parsed.data;
}

/**
 * The settings tree and the paths derived from it.
 *
 * Precedence for the workspace is `--workspace`, then the config file, then
 * `<root>/workspace`. `options.workspace` is an explicit instruction for one
 * run and must not be overridden by whatever the config happens to say; an
 * empty `agents.defaults.workspace` means "unset", so a root moved with
 * `GHOSTAI_HOME` takes its workspace with it.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const base = resolveGhostPaths(options);
  const file = options.file ?? base.configFile;

  let text: string | undefined;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = errnoOf(error);
    if (code === undefined || !ABSENT_CODES.has(code)) {
      throw new GhostError('config', `${file} could not be read`, {
        cause: error,
        details: { file },
      });
    }
  }

  const config = text === undefined ? ConfigSchema.parse({}) : parseConfig(text, file);
  const configured = config.agents.defaults.workspace;
  const workspace = options.workspace ?? (configured === '' ? undefined : configured);

  return {
    config,
    paths: resolveGhostPaths({
      ...options,
      ...(workspace === undefined ? {} : { workspace }),
    }),
    file,
    fromFile: text !== undefined,
  };
}
