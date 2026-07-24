/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runMcp } from './mcp.js';

try {
  await runMcp();
} catch {
  process.stderr.write('[external-context] startup failed\n');
  process.exitCode = 1;
}
