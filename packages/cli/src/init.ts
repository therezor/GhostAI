/**
 * `ghost init` — the terminal half of first-run setup.
 *
 * The browser gets a wizard behind a one-time code; this is the same six
 * questions for someone who never intends to open one. It writes exactly two
 * things — `config.json` through `saveConfig`, and a credential through the
 * vault — and reads the answers back through the same schema everything else
 * validates against, so an install configured here is indistinguishable from
 * one configured in the UI.
 *
 * Three decisions worth stating:
 *
 *  - **No prompt library.** `chat.ts` already drives `node:readline/promises`
 *    with an `AbortSignal`, and six questions is not worth a dependency in a
 *    package whose whole point is that `ghost --help` loads almost nothing.
 *    The helpers below are the parts that would otherwise be retyped per
 *    question, and they take their streams as arguments so a test drives them
 *    without a terminal.
 *
 *  - **Nothing is written until every question is answered.** An operator who
 *    presses Ctrl-C at the model prompt should not find a half-configured
 *    provider they now have to clean up. The answers are collected, then the
 *    config is merged and written once.
 *
 *  - **The model list is fetched, not guessed.** Every OpenAI-compatible
 *    endpoint answers `GET /models`, which covers every local server, so the
 *    question is a numbered list rather than a text box wherever it can be. A
 *    provider that cannot be reached says so and falls back to typing — an
 *    unreachable Ollama at this point usually means it is not running, and that
 *    is worth reading rather than working around.
 */

import { createInterface, type Interface } from 'node:readline/promises';

import { ConfigSchema, type Config, type ProviderConfig } from '@ghostai/protocol';
import {
  GhostError,
  ensureDir,
  loadConfig,
  saveConfig,
  type LoadedConfig,
} from '@ghostai/core';
import {
  PROVIDERS,
  createProvider,
  nextInstanceId,
  type ProviderSpec,
} from '@ghostai/providers';
import { PROVIDER_CREDENTIAL_NAMESPACE, openVault } from '@ghostai/runtime';
import pc from 'picocolors';

/** How long the model list gets before the question falls back to typing. */
const MODEL_FETCH_TIMEOUT_MS = 5000;

export interface InitOptions {
  /** `GHOSTAI_HOME` override. */
  readonly home?: string | undefined;
  readonly out?: NodeJS.WritableStream;
  readonly errOut?: NodeJS.WritableStream;
  readonly input?: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly colors?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected by tests so nothing here opens a socket. */
  readonly listModels?: (spec: ProviderSpec, apiBase: string, apiKey?: string) => Promise<string[]>;
  /** Injected by tests, which have no keychain. */
  readonly saveCredential?: (instanceId: string, value: string) => void;
}

/** The prompts, bound to one readline interface and one colour setting. */
interface Ask {
  /** A free-text answer, with `fallback` used for an empty line. */
  text(question: string, fallback?: string): Promise<string>;
  /** Reads without echoing, so a key does not land in the scrollback. */
  secret(question: string): Promise<string>;
  /** A numbered list. Returns the chosen index. */
  choose(question: string, options: readonly string[], fallbackIndex?: number): Promise<number>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
}

function createAsk(rl: Interface, out: NodeJS.WritableStream, colors: boolean | undefined): Ask {
  const c = pc.createColors(colors);

  const text = async (question: string, fallback?: string): Promise<string> => {
    const suffix = fallback === undefined || fallback === '' ? '' : c.dim(` [${fallback}]`);
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer === '' ? (fallback ?? '') : answer;
  };

  return {
    text,

    secret: async (question: string): Promise<string> => {
      // readline has no masked read, and `_writeToOutput` is the documented
      // seam for one — the alternative is a key sitting in the terminal's
      // scrollback for the rest of the session. Swapping the *interface's*
      // writer rather than the stream's matters: readline holds its own
      // reference to the output stream, and replacing `write` underneath it
      // deadlocks the very question being asked.
      const internal = rl as Interface & { _writeToOutput?: (text: string) => void };
      const original = internal._writeToOutput?.bind(internal);
      let masked = false;

      internal._writeToOutput = (text: string): void => {
        if (!masked) {
          original?.(text);
          return;
        }
        // The prompt itself still has to be drawn, or the line is invisible;
        // only what was typed after it is withheld.
        if (text.includes(question)) original?.(text);
      };

      try {
        const promise = rl.question(`${question}: `);
        masked = true;
        return (await promise).trim();
      } finally {
        masked = false;
        if (original === undefined) delete internal._writeToOutput;
        else internal._writeToOutput = original;
        out.write('\n');
      }
    },

    choose: async (
      question: string,
      options: readonly string[],
      fallbackIndex = 0,
    ): Promise<number> => {
      for (const [index, option] of options.entries()) {
        out.write(`  ${c.dim(String(index + 1).padStart(2))}  ${option}\n`);
      }
      for (;;) {
        const answer = await text(question, String(fallbackIndex + 1));
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && index >= 0 && index < options.length) return index;
        // By name as well as by number: an operator who types `ollama` has
        // answered the question, and refusing it would be pedantry.
        const named = options.findIndex((option) => option.toLowerCase().startsWith(answer.toLowerCase()));
        if (answer !== '' && named >= 0) return named;
        out.write(c.yellow(`  Enter a number between 1 and ${String(options.length)}.\n`));
      }
    },

    confirm: async (question: string, fallback: boolean): Promise<boolean> => {
      const answer = (await text(question, fallback ? 'Y/n' : 'y/N')).toLowerCase();
      if (answer.startsWith('y')) return true;
      if (answer.startsWith('n')) return false;
      return fallback;
    },
  };
}

/**
 * One endpoint's catalogue, or an empty list.
 *
 * Never throws: a provider that cannot be reached is a normal answer here — it
 * usually means the server is not running yet — and the question falls back to
 * typing a model id rather than ending the wizard.
 */
async function fetchModels(spec: ProviderSpec, apiBase: string, apiKey?: string): Promise<string[]> {
  if (spec.supportsModelListing !== true) return [];
  const provider = createProvider({
    provider: spec,
    apiBase,
    apiKey,
    // Retries are for a turn. A catalogue that does not answer promptly should
    // say so rather than spend fifteen seconds insisting.
    resilience: false,
  });
  try {
    const models = await provider.listModels(AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS));
    return models.map((model) => model.id);
  } catch {
    return [];
  } finally {
    await provider.close();
  }
}

/** What the wizard collected, before anything is written. */
interface Answers {
  readonly workspace: string;
  readonly instanceId: string;
  readonly instance: ProviderConfig;
  readonly model: string;
  readonly apiKey: string;
}

/**
 * Runs the wizard and returns the exit code.
 *
 * Returns rather than calling `process.exit`, like every other subcommand: the
 * config write has to land before the process ends.
 */
export async function initCommand(options: InitOptions = {}): Promise<number> {
  const out = options.out ?? process.stdout;
  const errOut = options.errOut ?? process.stderr;
  const input = options.input ?? process.stdin;
  const c = pc.createColors(options.colors);
  const listModels = options.listModels ?? fetchModels;

  const loaded: LoadedConfig = loadConfig({
    ...(options.home === undefined ? {} : { root: options.home }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  // A pipe cannot answer a question, and a wizard that read EOF as an answer
  // would write a config nobody chose.
  if (input.isTTY !== true) {
    errOut.write(
      '✖ `ghost init` needs a terminal.\n' +
        `  Edit ${loaded.file} directly, or run \`ghost serve\` and use the browser wizard.\n`,
    );
    return 1;
  }

  const rl = createInterface({ input, output: out, terminal: true });
  const ask = createAsk(rl, out, options.colors);

  try {
    out.write(`${c.bold('Setting up GhostAI.')}\n\n`);
    out.write(`  ${c.dim('Config')}  ${loaded.file}\n`);
    out.write(`  ${c.dim('Home')}    ${loaded.paths.root}\n\n`);

    const answers = await collect(ask, out, loaded, listModels, c);
    write(answers, loaded, options);

    out.write(`\n${c.bold('Done.')}\n\n`);
    out.write(`  ${c.dim('Provider')}   ${answers.instanceId}\n`);
    out.write(`  ${c.dim('Model')}      ${answers.model}\n`);
    out.write(`  ${c.dim('Workspace')}  ${answers.workspace}\n\n`);
    out.write(`Run ${c.cyan('ghost chat')} to talk to it, or ${c.cyan('ghost serve')} for the UI.\n`);
    return 0;
  } catch (error) {
    // Ctrl-C and Ctrl-D both arrive here, and neither is a failure worth a
    // stack trace: nothing has been written, which is the whole reason the
    // write happens last.
    if (isAbortError(error)) {
      out.write('\nStopped. Nothing was written.\n');
      return 1;
    }
    throw error;
  } finally {
    rl.close();
  }
}

/** Every question, in order. Writes nothing. */
async function collect(
  ask: Ask,
  out: NodeJS.WritableStream,
  loaded: LoadedConfig,
  listModels: NonNullable<InitOptions['listModels']>,
  c: ReturnType<typeof pc.createColors>,
): Promise<Answers> {
  const workspace = await ask.text('Workspace directory', loaded.paths.workspace);

  out.write('\nWhich provider?\n');
  const specs = PROVIDERS;
  const chosenIndex = await ask.choose(
    'Provider',
    specs.map((spec) => `${spec.displayName}${spec.isLocal === true ? c.dim(' (local)') : ''}`),
    specs.findIndex((spec) => spec.id === 'ollama'),
  );
  const spec = specs[chosenIndex];
  if (spec === undefined) throw new GhostError('config', 'No provider chosen');

  const label = await ask.text(`Name for this endpoint`, spec.displayName);
  const apiBase = await ask.text('API base', spec.defaultApiBase ?? '');

  // Offered for local providers too: a LAN model server behind an
  // authenticating proxy is a real configuration, and the credential lookup
  // reads the vault for one now.
  const apiKey = await ask.secret(
    spec.isLocal === true ? 'API token (optional, blank to skip)' : 'API key',
  );

  const instanceId = nextInstanceId(spec.id, Object.keys(loaded.config.providers));

  out.write('\n');
  const offered = await listModels(spec, apiBase, apiKey === '' ? undefined : apiKey);
  let model: string;
  if (offered.length > 0) {
    out.write(`${String(offered.length)} models available.\n`);
    const index = await ask.choose('Model', offered);
    model = offered[index] ?? '';
  } else {
    out.write(c.dim('Could not list models from this endpoint — type one instead.\n'));
    model = await ask.text('Model');
  }

  return {
    workspace,
    instanceId,
    instance: {
      type: spec.id,
      label: label === spec.displayName ? '' : label,
      apiBase,
      extraHeaders: {},
      models: [],
      enabled: true,
    },
    model,
    apiKey,
  };
}

/** The only two writes the wizard makes, both at the end. */
function write(answers: Answers, loaded: LoadedConfig, options: InitOptions): void {
  const merged: Config = ConfigSchema.parse({
    ...loaded.config,
    agents: {
      ...loaded.config.agents,
      defaults: {
        ...loaded.config.agents.defaults,
        workspace: answers.workspace,
        provider: answers.instanceId,
        model: answers.model,
      },
    },
    providers: { ...loaded.config.providers, [answers.instanceId]: answers.instance },
  });

  ensureDir(loaded.paths.root);
  saveConfig(loaded.file, merged);

  if (answers.apiKey === '') return;
  const save =
    options.saveCredential ??
    ((instanceId: string, value: string): void => {
      openVault(loaded.paths).set(PROVIDER_CREDENTIAL_NAMESPACE, instanceId, value);
    });
  save(answers.instanceId, answers.apiKey);
}

/** Ctrl-C at a prompt, and Ctrl-D closing stdin. Both mean "leave". */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || error.message.includes('closed'))
  );
}
