#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production bin entry wrapper.
 *
 * For most commands: launches dist/cli.js with --expose-gc so that
 * global.gc() is available for the memory-pressure monitor's critical-tier
 * cleanup.
 *
 * For `qwen serve`: imports cli.js directly in-process, skipping the
 * spawnSync overhead (~370ms on EDR-instrumented hosts). The daemon host
 * process never calls global.gc() — only its ACP children do, and they
 * independently add --expose-gc via spawnChannel.ts.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'dist', 'cli.js');

function isServeCommand() {
  return process.argv[2] === 'serve';
}

if (isServeCommand()) {
  process.argv[1] = cliPath;
  await import(pathToFileURL(cliPath).href);
} else {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', cliPath, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );

  if (result.signal) {
    process.kill(process.pid, result.signal);
  } else {
    process.exit(result.status ?? 1);
  }
}
