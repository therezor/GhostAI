import { readFileSync } from 'node:fs';

import { GhostError } from '@ghostbot/core';
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

  it('offers extension beside toolbox, as the other approval surface', async () => {
    // Approving code to load into the agent's own process is the one operator
    // action that cannot be delegated to the agent, and an install driven from
    // a terminal needs a way to do it without opening a browser.
    const run = await cli(['--help']);
    expect(run.out).toContain('extension');

    const help = await cli(['extension', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('list');
    expect(help.out).toContain('approve');
    expect(help.out).toContain('revoke');
  });

  it('offers install, the one command that sets an install up', async () => {
    const run = await cli(['--help']);
    expect(run.out).toContain('install');

    const help = await cli(['install', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('--presets-only');
  });

  it('offers agent, the preset installer, beside them', async () => {
    const run = await cli(['--help']);
    expect(run.out).toContain('agent');

    const help = await cli(['agent', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('install');
    expect(help.out).toContain('list');
  });

  it('returns a nested subcommand failure as its exit code', async () => {
    // The action on `agent install` receives the leaf command and records its
    // exit code there. A sweep of the top level alone read every nested
    // failure as success — `ghost toolbox approve nope` printed the refusal
    // and exited 0.
    const errOut = sink();
    const code = await runCli(
      [
        'node',
        'ghost',
        '--home',
        '/nonexistent-ghostai',
        'agent',
        'install',
        'nope',
      ],
      { out: sink(), errOut, env: {} },
    );

    expect(code).toBe(1);
    expect(errOut.text).toContain('No preset is available under "nope"');
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
      '-a',
      'reviewer',
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
      agentId: 'reviewer',
      workspace: '/tmp/ws',
      home: '/srv/ghost',
      fresh: true,
      showReasoning: false,
      tools: false,
    });
  });

  it('leaves the agent unset when no flag named one, so the stored binding decides', async () => {
    const run = await cli(['chat', 'hello']);
    const options = run.calls[0];
    expect(options === undefined ? [] : Object.keys(options)).not.toContain(
      'agentId',
    );
  });

  it('defaults the session and leaves unset overrides absent', async () => {
    const run = await cli(['chat', 'hello']);
    const options = run.calls[0];

    expect(options?.sessionKey).toBe('cli:default');
    // Absent, not `undefined`: the runtime distinguishes "no override" from a
    // value, and `exactOptionalPropertyTypes` is what keeps that honest.
    expect(options === undefined ? [] : Object.keys(options)).not.toContain(
      'model',
    );
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

  it('leaves the log level unset without --verbose, so chat picks its own', async () => {
    // `chatCommand` defaults to `error`: a chat prints the conversation, and a
    // warning about the install interrupts it on every turn to say the same
    // thing. Passing a level here would take that decision away from it.
    const run = await cli(['chat', 'hi']);
    expect(run.calls[0]?.logLevel).toBeUndefined();
  });

  it('--verbose asks for the install’s own reporting', async () => {
    // Before the subcommand: it is a global, listed on `ghost --help`, which is
    // where someone looks for it because `chat` is the default command.
    const run = await cli(['--verbose', 'chat', 'hi']);
    expect(run.calls[0]?.logLevel).toBe('info');
  });

  it('takes --verbose after the subcommand too, where a hand lands', async () => {
    // Commander accepts a global option in either position, and `ghost chat
    // --verbose` is what someone types who has already started the sentence.
    const run = await cli(['chat', '--verbose', 'hi']);
    expect(run.calls[0]?.logLevel).toBe('info');
  });

  it('leaves -v as --version, rather than shadowing it per subcommand', async () => {
    // `--verbose` has no short flag on purpose. A `-v` that printed the version
    // before `chat` and raised the log level after it is the kind of thing
    // nobody discovers until it bites.
    const run = await cli(['chat', '-v']);
    expect(run.out).toContain(VERSION);
    expect(run.calls).toHaveLength(0);
  });

  it('lets an explicit --log-level win over --verbose', async () => {
    // The more specific request: someone who named `debug` has asked for
    // something `--verbose` cannot spell.
    const run = await cli(['--log-level', 'debug', 'chat', '--verbose', 'hi']);
    expect(run.calls[0]?.logLevel).toBe('debug');
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

  it('drops one notch under its own default for --verbose', async () => {
    // `info` is already the floor here, because a server that says nothing
    // about the requests it is serving is a server nobody can debug. So
    // `--verbose` means `debug` — the same relative move it makes on `chat`.
    const run = await serve(['--verbose', 'serve']);
    expect(run.calls[0]?.logLevel).toBe('debug');
  });

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
    const flag = await serve([
      'serve',
      '--password',
      'hunter2hunter2',
      '--username',
      'operator',
    ]);
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
