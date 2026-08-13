#!/usr/bin/env node
/**
 * The `ghostai` binary.
 *
 * Everything this file does is set an exit code. It sets `process.exitCode`
 * rather than calling `process.exit`, because `exit` tears the process down with
 * whatever is still buffered on stdout unwritten — and on a piped `ghostai chat`,
 * what is still buffered is the answer.
 *
 * The one thing it does first is silence Node's `node:sqlite` warning, and that
 * is why `./program.js` arrives through `import()` rather than at the top of
 * the file. The warning fires when `node:sqlite` is *loaded*, `program.ts`
 * imports `agent.ts` which imports it at module scope, and a static import
 * evaluates before any of this file's body — so a call placed under the imports
 * would run a fraction too late, every time. This is the whole reason for the
 * dynamic import; it is not a code-splitting decision, and moving it back to a
 * static import puts the warning back.
 */

import { silenceSqliteExperimentalWarning } from './warnings.js';

silenceSqliteExperimentalWarning();

const { runCli } = await import('./program.js');

process.exitCode = await runCli(process.argv);
