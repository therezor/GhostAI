#!/usr/bin/env node
/**
 * Regenerates `docs/screenshots/demo.svg` — the animated terminal cast at the
 * top of the README.
 *
 * `pnpm demo`. Everything is local and nothing is faked:
 *
 *  1. A mock provider on 127.0.0.1:11500 speaking the `openai-chat` wire,
 *     scripted to call `list_dir` and then answer from what came back — the
 *     same shape `packages/e2e/src/harness/script.ts` gives the browser suite.
 *     It drives the **real** `ghostai` binary through a real config, because a
 *     recording of a mock is not a recording of the product.
 *  2. A throwaway install, seeded with one file for the agent to find.
 *  3. `scripts/ptyrec.py` records **bash** on a real pty, types `ghostai chat`,
 *     waits for the TUI, asks the question, and leaves. Keystrokes are
 *     scheduled so the run reproduces; the timings in the cast are the real
 *     ones, and every byte on screen came back through the pty from the
 *     programs themselves.
 *  4. `svg-term` renders the cast to a self-contained animated SVG.
 *
 * **Why a pty and not a pipe.** Piping `ghostai chat` gets you the plain stream
 * it writes for a machine: no session header, no composer, no status bar, no
 * spinner. That is a demo of the wrong thing. The child has to believe it is on
 * a terminal, and `script` needs a controlling terminal this repo's tooling does
 * not always have — `pty` is in Python's stdlib and needs nothing.
 *
 * **Why an SVG and not a GIF.** A tenth the size, stays sharp at any width, and
 * GitHub serves it from the repo with no external host — the same rule
 * `packages/web/test/self-contained.test.ts` holds the product to. CSS
 * animations inside an SVG run when it is loaded through an `<img>`; scripts do
 * not, which is why `svg-term`'s output works here at all.
 */

import { execFileSync, spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'screenshots', 'demo.svg');
const REC = join(ROOT, 'scripts', 'ptyrec.py');
const PORT = 11500;
const MODEL = 'qwen3:8b';
const QUESTION = 'what is in the workspace?';
const COLS = 92;
const ROWS = 30;

/** A throwaway install pointed at the mock, with one file to find. */
function seedHome() {
  // A fixed, short path. Not `mkdtemp`, because the session header prints the
  // workspace and a random suffix would change the picture on every run — and
  // not `tmpdir()` either, which on macOS is a 50-character `/var/folders/...`
  // that wraps the header and tells a reader nothing.
  const home = '/tmp/ghostai-demo';
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'workspace'), { recursive: true });
  mkdirSync(join(home, 'bin'), { recursive: true });

  writeFileSync(
    join(home, 'workspace', 'notes.md'),
    '# Notes\n\nRemember to water the plants.\n',
  );
  // A real `ghostai` on PATH, so the typed command is the one a reader will type.
  const shim = join(home, 'bin', 'ghost');
  writeFileSync(
    shim,
    `#!/bin/sh\nexec node ${join(ROOT, 'packages', 'cli', 'dist', 'index.js')} "$@"\n`,
  );
  chmodSync(shim, 0o755);

  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify(
      {
        agents: {
          defaults: { provider: 'local', model: MODEL },
          list: {
            default: {
              tools: {
                read_file: 'allow',
                list_dir: 'allow',
                write_file: 'allow',
                edit_file: 'allow',
              },
            },
          },
        },
        providers: {
          local: {
            type: 'custom',
            label: 'local',
            apiBase: `http://127.0.0.1:${String(PORT)}`,
          },
        },
      },
      null,
      2,
    ),
  );
  return home;
}

const type = (text, perChar) => [...text].map((c) => [perChar, c]);

const ESC = String.fromCharCode(27);

/**
 * Makes the dim text actually dim.
 *
 * The CLI leans on SGR 2 (faint) for everything secondary — the header labels,
 * the timings, the byte counts, the whole status bar — a few hundred times in a
 * ten-second take. **svg-term ignores SGR 2**, so all of it renders at full
 * white and the recording has no visual hierarchy at all: the workspace path
 * shouts as loudly as the answer. You can see it in the output, which carries
 * exactly three fills — white, green, cyan — and no grey.
 *
 * So faint is rewritten to faint *plus* an explicit 256-colour grey, which
 * svg-term does honour. This is a concession to the renderer, not a change to
 * what the program did: a real terminal draws SGR 2 grey, and this is how it
 * looks there.
 *
 * `22` resets intensity, so it needs `39` beside it to put the foreground back
 * — and only `39`, because `22` also ends bold and the wordmark relies on that.
 */
function faintToGrey(castPath) {
  const lines = readFileSync(castPath, 'utf8').split('\n');
  const out = lines.map((line, i) => {
    if (i === 0 || line === '') return line;
    const event = JSON.parse(line);
    event[2] = event[2]
      .split(`${ESC}[2m`)
      .join(`${ESC}[2;38;5;245m`)
      .split(`${ESC}[22m`)
      .join(`${ESC}[22;39m`);
    return JSON.stringify(event);
  });
  writeFileSync(castPath, out.join('\n'));
}

/** The take. Slow enough to read, short enough to loop. */
const TAKE = [
  [0.9, ''],
  ...type('ghostai chat', 0.07),
  [0.45, '\r'],
  [1.9, ''],
  ...type(QUESTION, 0.055),
  [0.45, '\r'],
  // No `/exit`: the recorder stops once the screen goes quiet, so the loop ends
  // on the finished conversation rather than on the TUI tearing down.
  [4.5, ''],
];

// A child process, not a server in this one: `execFileSync` below blocks this
// event loop for the whole take, and an in-process server would accept nothing.
const provider = spawn(
  process.execPath,
  [join(ROOT, 'scripts', 'demo-provider.mjs')],
  { stdio: ['ignore', 'pipe', 'inherit'] },
);
await new Promise((resolve, reject) => {
  provider.stdout.once('data', resolve);
  provider.once('exit', (code) =>
    reject(new Error(`the mock provider exited with ${String(code)}`)),
  );
});

const home = seedHome();
const work = mkdtempSync(join(tmpdir(), 'ghostai-cast-'));

const record = (keys, castPath) => {
  writeFileSync(join(work, 'keys.json'), JSON.stringify(keys));
  execFileSync(
    'python3',
    [
      REC,
      String(COLS),
      String(ROWS),
      castPath,
      join(work, 'keys.json'),
      '--',
      'bash',
      '--norc',
      '--noprofile',
      '-i',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        GHOSTAI_HOME: home,
        PATH: `${join(home, 'bin')}:${process.env.PATH ?? ''}`,
        PS1: '❯ ',
        BASH_SILENCE_DEPRECATION_WARNING: '1',
      },
    },
  );
};

try {
  const cast = join(work, 'ghost.cast');
  record(TAKE, cast);
  faintToGrey(cast);

  mkdirSync(dirname(OUT), { recursive: true });
  execFileSync(
    'npx',
    [
      '--yes',
      'svg-term-cli@2.1.1',
      '--in',
      cast,
      '--out',
      OUT,
      '--window',
      '--width',
      String(COLS),
      '--height',
      String(ROWS),
      '--padding',
      '14',
    ],
    { stdio: 'inherit' },
  );
  process.stdout.write(`wrote ${OUT}\n`);
} finally {
  provider.kill();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
