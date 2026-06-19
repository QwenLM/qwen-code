#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production bin entry wrapper for the standalone Blaze agent runtime.
 *
 * Launches dist/blaze-runtime.js with --expose-gc so the runtime has the
 * same memory-pressure behavior as the original qwen CLI entry.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimePath = join(__dirname, '..', 'dist', 'blaze-runtime.js');

const result = spawnSync(
  process.execPath,
  ['--expose-gc', runtimePath, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
