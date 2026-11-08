/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConfigurationError } from './config.js';
import { runMcp } from './mcp.js';
import { installEnvironmentProxy } from './proxy.js';

try {
  installEnvironmentProxy();
  await runMcp();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : 'External context startup failed.';
  process.stderr.write(`[external-context] ${message}\n`);
  process.exitCode = 1;
}
