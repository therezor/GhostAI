#!/usr/bin/env node
/**
 * The `ghost` binary.
 *
 * Everything this file does is set an exit code. It sets `process.exitCode`
 * rather than calling `process.exit`, because `exit` tears the process down with
 * whatever is still buffered on stdout unwritten — and on a piped `ghost chat`,
 * what is still buffered is the answer.
 */

import { runCli } from './program.js';

process.exitCode = await runCli(process.argv);
