#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production bin entry wrapper.
 *
 * Launches dist/cli.js with --expose-gc so that global.gc() is available
 * for the memory-pressure monitor's critical-tier cleanup.
 *
 * --expose-gc only exposes the function; it has zero runtime cost.
 * global.gc() is called only when RSS hits the critical threshold (0.80),
 * where the 10-200 ms pause is acceptable to avoid an OOM kill.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, '..', 'dist', 'cli.js');

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
