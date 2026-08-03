import { readFileSync } from 'node:fs';

import { GhostError } from '@ghostai/core';
import { describe, expect, it } from 'vitest';

import type { ChatOptions } from '#src/chat.js';
import { VERSION, runCli } from '#src/program.js';
import type { ServeCommandOptions } from '#src/serve.js';

function sink(): NodeJS.WritableStream & { text: string } {
  const target = {
    text: '',
    write(chunk: string): boolean {
      target.text += chunk;
      return true;
    },
  };
  return target as unknown as NodeJS.WritableStream & { text: string };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly calls: ChatOptions[];
}

async function cli(
  args: readonly string[],
  runChat?: (options: ChatOptions) => Promise<number>,
): Promise<Run> {
  const out = sink();
  const errOut = sink();
  const calls: ChatOptions[] = [];
  const code = await runCli(['node', 'ghost', ...args], {
    out,
    errOut,
    env: {},
    runChat: async (options) => {
      calls.push(options);
      return runChat === undefined ? 0 : await runChat(options);
    },
  });
  return { code, out: out.text, err: errOut.text, calls };
}

describe('runCli', () => {
  it('keeps VERSION in step with the manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(VERSION).toBe(manifest.version);
  });

  it('prints help and exits zero without loading the agent', async () => {
    const run = await cli(['--help']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('Usage: ghost');
    expect(run.out).toContain('chat');
    expect(run.calls).toHaveLength(0);
  });

  it('prints the version', async () => {
    const run = await cli(['--version']);
    expect(run.code).toBe(0);
    expect(run.out.trim()).toBe(VERSION);
  });

  it('fails on an unknown option instead of guessing', async () => {
    const run = await cli(['--nonsense']);
    expect(run.code).not.toBe(0);
  });

  it('treats a bare message as chat, which is the default command', async () => {
    const run = await cli(['what', 'is', 'here?']);
    expect(run.calls[0]?.message).toBe('what is here?');
  });

  it('opens the prompt when there is no message', async () => {
    const run = await cli(['chat']);
    expect(run.calls[0]).toBeDefined();
    expect(run.calls[0]?.message).toBeUndefined();
  });

  it('maps every flag onto the chat options', async () => {
    const run = await cli([
      '--home',
      '/srv/ghost',
      'chat',
      '-s',
      'work',
      '-m',
      'qwen3',
      '-p',
      'ollama',
      '-w',
      '/tmp/ws',
      '--new',
      '--no-reasoning',
      '--no-tools',
      'go',
    ]);

    expect(run.calls[0]).toMatchObject({
      message: 'go',
      sessionKey: 'work',
      model: 'qwen3',
      provider: 'ollama',
      workspace: '/tmp/ws',
      home: '/srv/ghost',
      fresh: true,
      showReasoning: false,
      tools: false,
    });
  });

  it('defaults the session and leaves unset overrides absent', async () => {
    const run = await cli(['chat', 'hello']);
    const options = run.calls[0];

    expect(options?.sessionKey).toBe('cli:default');
    // Absent, not `undefined`: the runtime distinguishes "no override" from a
    // value, and `exactOptionalPropertyTypes` is what keeps that honest.
    expect(options === undefined ? [] : Object.keys(options)).not.toContain('model');
  });

  it('turns colour off in --json mode so the output stays parseable', async () => {
    const run = await cli(['chat', '--json', 'hi']);
    expect(run.calls[0]?.json).toBe(true);
    expect(run.calls[0]?.colors).toBe(false);
  });

  it('honours --no-color for prose output', async () => {
    const run = await cli(['--no-color', 'chat', 'hi']);
    expect(run.calls[0]?.colors).toBe(false);
  });

  it('rejects a log level pino would not understand', async () => {
    // pino throws on an unknown level, and losing the logger loses the
    // diagnostics needed to work out why it was lost.
    const run = await cli(['--log-level', 'chatty', 'chat', 'hi']);
    expect(run.code).toBe(1);
  });

  it('accepts a valid log level', async () => {
    const run = await cli(['--log-level', 'debug', 'chat', 'hi']);
    expect(run.code).toBe(0);
  });

  it('returns the exit code the command produced', async () => {
    const run = await cli(['chat', 'hi'], async () => 130);
    expect(run.code).toBe(130);
  });

  it('reports a configuration failure as a message, not a stack trace', async () => {
    const run = await cli(['chat', 'hi'], () => {
      throw new GhostError('config', 'No provider could be resolved.');
    });

    expect(run.code).toBe(1);
    expect(run.err).toContain('✖ No provider could be resolved.');
    expect(run.err).not.toContain('at ');
  });

  it('includes the stack when GHOSTAI_DEBUG asks for it', async () => {
    const errOut = sink();
    const code = await runCli(['node', 'ghost', 'chat', 'hi'], {
      out: sink(),
      errOut,
      env: { GHOSTAI_DEBUG: '1' },
      runChat: () => {
        throw new GhostError('config', 'boom');
      },
    });

    expect(code).toBe(1);
    expect(errOut.text).toContain('at ');
  });

  it('reports an unexpected failure with its stack', async () => {
    const run = await cli(['chat', 'hi'], () => {
      throw new TypeError('undefined is not a function');
    });

    expect(run.code).toBe(1);
    expect(run.err).toContain('undefined is not a function');
  });
});

describe('ghost serve', () => {
  /** The parser, with the server stubbed: nothing here binds a port. */
  async function serve(
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>> = {},
  ): Promise<{ code: number; err: string; calls: ServeCommandOptions[] }> {
    const out = sink();
    const errOut = sink();
    const calls: ServeCommandOptions[] = [];
    const code = await runCli(['node', 'ghost', ...args], {
      out,
      errOut,
      env,
      runServe: async (options) => {
        calls.push(options);
        return 0;
      },
    });
    return { code, err: errOut.text, calls };
  }

  it('maps every flag onto the serve options', async () => {
    const run = await serve([
      'serve',
      '--host',
      '0.0.0.0',
      '--port',
      '8080',
      '--workspace',
      '/tmp/ws',
      '--password',
      'hunter2',
      '--ui',
      '/tmp/dist',
    ]);

    expect(run.code).toBe(0);
    expect(run.calls[0]).toMatchObject({
      host: '0.0.0.0',
      port: 8080,
      workspace: '/tmp/ws',
      password: 'hunter2',
      ui: '/tmp/dist',
      logLevel: 'info',
    });
  });

  it('reads the password from the environment when the flag is absent', async () => {
    const run = await serve(['serve'], { GHOSTAI_PASSWORD: 'from-the-env' });

    expect(run.calls[0]?.password).toBe('from-the-env');
  });

  it('leaves the password unset rather than passing an empty one', async () => {
    const run = await serve(['serve'], { GHOSTAI_PASSWORD: '' });

    expect(run.calls[0]?.password).toBeUndefined();
  });

  it('passes the username through, from the flag or the environment', async () => {
    const flag = await serve(['serve', '--password', 'hunter2hunter2', '--username', 'operator']);
    expect(flag.calls[0]?.username).toBe('operator');

    const env = await serve(['serve'], {
      GHOSTAI_PASSWORD: 'hunter2hunter2',
      GHOSTAI_USERNAME: 'operator',
    });
    expect(env.calls[0]?.username).toBe('operator');
  });

  it('leaves the username unset rather than passing an empty one', async () => {
    const run = await serve(['serve'], { GHOSTAI_USERNAME: '' });

    expect(run.calls[0]?.username).toBeUndefined();
  });

  it('refuses a port that is not one, before anything binds', async () => {
    const run = await serve(['serve', '--port', 'http']);

    expect(run.code).toBe(1);
    expect(run.calls).toHaveLength(0);
  });

  it('is listed in the help without loading the server', async () => {
    const run = await cli(['--help']);

    expect(run.out).toContain('serve');
  });
});
