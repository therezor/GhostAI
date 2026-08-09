/**
 * `ghost init`, driven through its own streams.
 *
 * Two properties decide whether this landed, and neither is about the prompts:
 *
 *  - **What it writes is a config the rest of the system reads.** The file goes
 *    through `saveConfig`, so it validates against `ConfigSchema`, and
 *    `createRuntime` over the same home comes up configured. A wizard that
 *    produced a file only it could read would be a second config format.
 *  - **It writes nothing until every question is answered.** An operator who
 *    walks away at the model prompt has a clean install, not a half-configured
 *    provider to clean up.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { ConfigSchema } from '@ghostbot/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { initCommand, type InitOptions } from '#src/init.js';

const homes: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghostai-init-'));
  homes.push(dir);
  return dir;
}

afterEach(() => {
  while (homes.length > 0) {
    const dir = homes.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Run {
  readonly code: number;
  readonly output: string;
  readonly errors: string;
  readonly credentials: Array<{ instanceId: string; value: string }>;
  readonly home: string;
}

/**
 * Feeds `answers` in as if typed, one per prompt.
 *
 * Reactively, not all at once, and that is not fussiness: readline in terminal
 * mode reads input as keypresses, so a buffer written before the question is
 * asked delivers its first line and swallows the rest. Watching the output for
 * a prompt and answering it is what a person does anyway.
 *
 * The stream is a `PassThrough` marked `isTTY`, because the wizard refuses a
 * pipe on purpose — a stream that answers EOF to every question would write a
 * config nobody chose.
 */
async function run(
  answers: readonly string[],
  overrides: Partial<InitOptions> & { readonly home?: string } = {},
): Promise<Run> {
  const home = overrides.home ?? tempHome();
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;

  let output = '';
  let errors = '';
  const out = new PassThrough();
  const errOut = new PassThrough();
  errOut.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });

  let next = 0;
  let sinceAnswer = '';
  out.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    output += text;
    sinceAnswer += text;
    // A prompt is a line ending in `": "`, once the cursor escapes readline
    // emits around it are taken out.
    // eslint-disable-next-line no-control-regex -- the escapes are the subject
    const plain = sinceAnswer.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
    if (!plain.endsWith(': ') || next >= answers.length) return;
    const answer = answers[next];
    next += 1;
    sinceAnswer = '';
    setImmediate(() => input.write(`${answer ?? ''}\n`));
  });

  const credentials: Array<{ instanceId: string; value: string }> = [];

  const code = await initCommand({
    home,
    input,
    out,
    errOut,
    colors: false,
    env: {},
    listModels: async () => ['qwen3:8b', 'llama3'],
    saveCredential: (instanceId, value) => {
      credentials.push({ instanceId, value });
    },
    ...overrides,
  });

  return { code, output, errors, credentials, home };
}

function configIn(home: string): unknown {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as unknown;
}

describe('initCommand', () => {
  it('writes a config the schema accepts, naming the instance it created', async () => {
    const { code, home } = await run([
      '', // workspace: the default
      'ollama', // provider, by name rather than by number
      'Laptop', // label
      '', // API base: the provider's default
      '', // no token
      '1', // the first model offered
      '3', // agents: nothing for now
    ]);

    expect(code).toBe(0);
    const written = configIn(home);
    expect(() => ConfigSchema.parse(written)).not.toThrow();
    expect(written).toMatchObject({
      agents: { defaults: { provider: 'ollama', model: 'qwen3:8b' } },
      providers: { ollama: { type: 'ollama', label: 'Laptop' } },
    });
  });

  it('stores a token for a local endpoint, which the vault used to skip', async () => {
    const { credentials } = await run([
      '',
      'ollama',
      '',
      '',
      'proxy-token',
      '1',
      '3',
    ]);
    expect(credentials).toEqual([
      { instanceId: 'ollama', value: 'proxy-token' },
    ]);
  });

  it('writes no credential when the token is left blank', async () => {
    const { credentials } = await run(['', 'ollama', '', '', '', '1', '3']);
    expect(credentials).toEqual([]);
  });

  it('names a second endpoint of the same type rather than overwriting the first', async () => {
    const home = tempHome();
    await run(['', 'ollama', 'Laptop', '', '', '1', '3'], { home });
    await run(
      ['', 'ollama', 'GPU box', 'http://gpu.lan:11434/v1', '', '2', '3'],
      {
        home,
      },
    );

    const written = configIn(home) as {
      providers: Record<string, { label?: string }>;
    };
    expect(Object.keys(written.providers)).toEqual(['ollama', 'ollama-2']);
    expect(written.providers['ollama-2']?.label).toBe('GPU box');
  });

  it('falls back to typing a model when the endpoint cannot be listed', async () => {
    // An unreachable Ollama usually means it is not running, which is worth
    // reading rather than working around — but it must not end the wizard.
    const { code, home, output } = await run(
      ['', 'ollama', '', '', '', 'typed-by-hand', '3'],
      {
        listModels: async () => [],
      },
    );

    expect(code).toBe(0);
    expect(output).toContain('Could not list models');
    expect(configIn(home)).toMatchObject({
      agents: { defaults: { model: 'typed-by-hand' } },
    });
  });

  it('refuses a pipe rather than reading EOF as an answer', async () => {
    const input = new PassThrough();
    let errors = '';
    const errOut = new PassThrough();
    errOut.on('data', (chunk: Buffer) => (errors += chunk.toString()));

    const home = tempHome();
    const code = await initCommand({
      home,
      input,
      out: new PassThrough(),
      errOut,
      colors: false,
      env: {},
    });

    expect(code).toBe(1);
    expect(errors).toContain('needs a terminal');
    expect(existsSync(join(home, 'config.json'))).toBe(false);
  });

  it('keeps asking until the provider answer is one of the offered ones', async () => {
    const { code, home, output } = await run([
      '',
      'not-a-provider',
      '99',
      'ollama',
      '',
      '',
      '',
      '1',
      '3',
    ]);

    expect(code).toBe(0);
    expect(output).toContain('Enter a number between');
    expect(configIn(home)).toMatchObject({
      providers: { ollama: { type: 'ollama' } },
    });
  });
});
