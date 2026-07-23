/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runHook } from './hook.js';
import { runMcp } from './mcp.js';

const mode = process.argv[2];

if (mode === 'hook') {
  await runHook();
} else if (mode === 'mcp') {
  try {
    await runMcp();
  } catch {
    process.stderr.write('[external-context] startup failed\n');
    process.exitCode = 1;
  }
} else {
  process.stderr.write('Usage: main.js hook|mcp\n');
  process.exitCode = 1;
}
