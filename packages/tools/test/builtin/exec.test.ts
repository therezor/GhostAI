import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isGhostError, type GhostError } from '@ghostai/core';

import {
  toToolResult,
  type ToolContext,
  type ToolResult,
} from '#src/define.js';
import { ToolRegistry } from '#src/registry.js';
import type { CommandRunner, RunRequest } from '#src/runner.js';
import { createTestWorkspace, type TestWorkspace } from '#testkit/workspace.js';
import { execTool } from '#src/builtin/exec.js';
import { builtinTools, registerBuiltins } from '#src/builtin/index.js';

const NODE = process.execPath;

let workspace: TestWorkspace;
let context: ToolContext;

beforeEach(() => {
  workspace = createTestWorkspace();
  context = workspace.context;
});

afterEach(() => {
  workspace.dispose();
});

async function run(args: unknown, ctx = context): Promise<ToolResult> {
  return toToolResult(await execTool.run(args, ctx));
}

async function failure(args: unknown, ctx = context): Promise<GhostError> {
  const error = await execTool.run(args, ctx).then(
    () => null,
    (value: unknown) => value,
  );
  if (!isGhostError(error)) {
    throw new Error(`expected a GhostError, got ${String(error)}`);
  }
  return error;
}

describe('exec', () => {
  it('runs a program and returns its output', async () => {
    const result = await run({
      argv: [NODE, '-e', 'process.stdout.write("hello")'],
    });
    expect(result.isError).toBe(false);
    expect(result.content).toBe('hello\n\nExit code: 0');
  });

  it('runs in the workspace root, so relative arguments resolve', async () => {
    writeFileSync(join(workspace.root, 'data.txt'), 'contents');
    const result = await run({
      argv: [
        NODE,
        '-e',
        'process.stdout.write(require("node:fs").readFileSync("data.txt","utf8"))',
      ],
    });
    expect(result.content).toContain('contents');
  });

  it('reports a non-zero exit as a result, not a thrown failure', async () => {
    // `grep` finding nothing exits 1, and a compiler failing is the answer the
    // model asked for — the output has to survive.
    const result = await run({
      argv: [NODE, '-e', 'process.stderr.write("nope"); process.exit(3)'],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('[stderr]\nnope');
    expect(result.content).toContain('Exit code: 3');
  });

  it('says so when a program produced nothing', async () => {
    const result = await run({ argv: [NODE, '-e', ''] });
    expect(result.content).toContain('(no output)');
  });

  it('reports both streams', async () => {
    const result = await run({
      argv: [
        NODE,
        '-e',
        'process.stdout.write("out"); process.stderr.write("err")',
      ],
    });
    expect(result.content).toContain('out');
    expect(result.content).toContain('[stderr]\nerr');
  });

  it('records argv and the validated paths for the audit log', async () => {
    writeFileSync(join(workspace.root, 'data.txt'), 'x');
    const result = await run({ argv: [NODE, '-e', '0', './data.txt'] });
    expect(result.details).toMatchObject({
      exitCode: 0,
      paths: [join(workspace.root, 'data.txt')],
    });
  });

  it('reports a program that does not exist', async () => {
    const error = await failure({ argv: ['ghostai-definitely-not-a-binary'] });
    expect(error.kind).toBe('tool');
    expect(error.message).toContain('Could not run');
  });

  it('refuses a shell', async () => {
    const error = await failure({ argv: ['bash', '-c', 'echo pwned'] });
    expect(error.kind).toBe('permission_denied');
    expect(error.message).toContain('shell');
  });

  it('refuses a denied binary', async () => {
    const error = await failure(
      { argv: ['curl', 'https://example.com'] },
      workspace.with({
        exec: { ...context.config.exec, deniedBinaries: ['curl'] },
      }),
    );
    expect(error.kind).toBe('permission_denied');
  });

  it('refuses an argument reaching outside the workspace', async () => {
    const error = await failure({
      argv: [NODE, '-e', '0', '../../etc/passwd'],
    });
    expect(error.kind).toBe('jail_escape');
  });

  it('refuses to run at all when exec is disabled', async () => {
    const error = await failure(
      { argv: [NODE, '-e', '0'] },
      workspace.with({ exec: { ...context.config.exec, enable: false } }),
    );
    expect(error.kind).toBe('permission_denied');
  });

  it('passes only the allow-listed environment through', async () => {
    const result = await run(
      {
        argv: [
          NODE,
          '-e',
          'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))',
        ],
      },
      {
        ...context,
        env: { PATH: '/usr/bin', HOME: '/home/x', GHOSTAI_API_KEY: 'secret' },
      },
    );
    expect(result.content).toContain('PATH');
    expect(result.content).not.toContain('GHOSTAI_API_KEY');
  });

  it('caps output while the child writes, keeping the head of it', async () => {
    const result = await run(
      { argv: [NODE, '-e', 'process.stdout.write("z".repeat(200000))'] },
      workspace.with({ exec: { ...context.config.exec, maxOutputBytes: 64 } }),
    );
    expect(result.content).toContain('output truncated at 64 bytes');
    expect(result.content).toContain('z'.repeat(64));
  });

  it('kills a program that outlives its timeout', async () => {
    const result = await run({
      argv: [NODE, '-e', 'setTimeout(() => {}, 60000)'],
      timeoutMs: 150,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('exceeding its time limit');
  });

  it('lets the model ask for less time than the operator allows, never more', async () => {
    const started = Date.now();
    const result = await run(
      { argv: [NODE, '-e', 'setTimeout(() => {}, 60000)'], timeoutMs: 5_000 },
      workspace.with({ exec: { ...context.config.exec, timeoutMs: 150 } }),
    );
    expect(result.content).toContain('exceeding its time limit');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('applies the operator timeout when the model asks for none', async () => {
    const result = await run(
      { argv: [NODE, '-e', 'setTimeout(() => {}, 60000)'] },
      workspace.with({ exec: { ...context.config.exec, timeoutMs: 150 } }),
    );
    expect(result.content).toContain('exceeding its time limit');
  });

  it('kills the child when the turn is aborted', async () => {
    const running = execTool.run(
      { argv: [NODE, '-e', 'setTimeout(() => {}, 60000)'] },
      context,
    );
    setTimeout(() => {
      workspace.controller.abort();
    }, 50);
    const error = await running.then(
      () => null,
      (value: unknown) => value,
    );
    expect(isGhostError(error) && error.kind).toBe('aborted');
  });

  it('surfaces the abort through the registry as a cancellation', async () => {
    const registry = new ToolRegistry();
    registry.register(execTool);
    const running = registry.execute(
      {
        name: 'exec',
        argumentsJson: JSON.stringify({
          argv: [NODE, '-e', 'setTimeout(() => {}, 60000)'],
        }),
      },
      context,
    );
    setTimeout(() => {
      workspace.controller.abort();
    }, 50);
    await expect(running).resolves.toMatchObject({
      isError: true,
      errorKind: 'aborted',
    });
  });
});

describe('the built-in set', () => {
  it('registers every built-in under the builtin source', () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry);
    expect(registry.names()).toEqual([
      'automation',
      'edit_file',
      'exec',
      'list_dir',
      'read_file',
      'write_file',
    ]);
    expect(registry.sourceOf('exec')).toBe('builtin');
  });

  it('does not advertise exec when config disables it', () => {
    // A disabled tool the model can still see costs it a turn to discover.
    const registry = new ToolRegistry();
    registerBuiltins(
      registry,
      workspace.with({ exec: { ...context.config.exec, enable: false } })
        .config,
    );
    expect(registry.has('exec')).toBe(false);
    expect(registry.size).toBe(5);
  });

  it('does not advertise automation when the scheduler is switched off', () => {
    // The same rule as exec, for the same reason: an install that cannot
    // schedule should not offer a way to.
    const registry = new ToolRegistry();
    registerBuiltins(registry, context.config, { scheduler: false });
    expect(registry.has('automation')).toBe(false);
    expect(registry.has('exec')).toBe(true);
  });

  it('includes both by default and with no config at all', () => {
    expect(builtinTools()).toHaveLength(6);
    expect(builtinTools(context.config)).toHaveLength(6);
  });
});

describe('the runner seam', () => {
  /** Records what it was asked to run, and answers without a process. */
  function recording(): { runner: CommandRunner; seen: RunRequest[] } {
    const seen: RunRequest[] = [];
    return {
      seen,
      runner: {
        run: (request) => {
          seen.push(request);
          return Promise.resolve({
            stdout: 'from somewhere else',
            stderr: '',
            truncated: false,
            code: 0,
            signal: null,
            timedOut: false,
          });
        },
      },
    };
  }

  it('runs on the host when the context names no runner', async () => {
    // The default has to stay the behaviour exec has always had, or every
    // existing caller changes meaning without changing code.
    const result = toToolResult(
      await execTool.run(
        { argv: [NODE, '-e', 'process.stdout.write("local")'] },
        context,
      ),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('local');
  });

  it('uses the context’s runner instead of spawning', async () => {
    const { runner, seen } = recording();
    const result = toToolResult(
      await execTool.run(
        { argv: [NODE, '-e', 'process.exit(1)'] },
        { ...context, runner },
      ),
    );

    expect(seen).toHaveLength(1);
    expect(result.content).toContain('from somewhere else');
    expect(result.isError).toBe(false);
  });

  it('hands the runner a plan that is already guarded', async () => {
    // Whether a command may run is settled before a runner sees it, so a
    // backend never has to re-implement policy.
    const { runner, seen } = recording();
    await execTool.run({ argv: [NODE, '--version'] }, { ...context, runner });

    const plan = seen[0]?.plan;
    expect(plan?.cwd).toBe(workspace.root);
    expect(plan?.file).toBe(NODE);
    expect(Object.keys(plan?.env ?? {})).toContain('PATH');
  });

  it('still refuses a denied command before any runner is consulted', async () => {
    const { runner, seen } = recording();
    const denied = workspace.with({
      exec: { ...context.config.exec, deniedBinaries: ['node'] },
    });

    await expect(
      execTool.execute({ argv: [NODE, '--version'] }, { ...denied, runner }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it('passes the reconciled timeout, not the model’s request', async () => {
    const { runner, seen } = recording();
    const capped = workspace.with({
      exec: { ...context.config.exec, timeoutMs: 5_000 },
    });

    await execTool.run(
      { argv: [NODE, '--version'], timeoutMs: 60_000 },
      { ...capped, runner },
    );

    expect(seen[0]?.timeoutMs).toBe(5_000);
  });
});
