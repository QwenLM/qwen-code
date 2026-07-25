/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { ConfigurationError } from './config.js';
import { runMcp } from './mcp.js';

try {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  await runMcp();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : 'External context startup failed.';
  process.stderr.write(`[external-context] ${message}\n`);
  process.exitCode = 1;
}
