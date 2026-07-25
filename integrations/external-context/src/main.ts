/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { ConfigurationError } from './config.js';
import { runMcp } from './mcp.js';

try {
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch {
    throw new ConfigurationError(
      'Proxy environment configuration is invalid. Check HTTP_PROXY, HTTPS_PROXY, and NO_PROXY.',
    );
  }
  await runMcp();
} catch (error) {
  const message =
    error instanceof ConfigurationError
      ? error.message
      : 'External context startup failed.';
  process.stderr.write(`[external-context] ${message}\n`);
  process.exitCode = 1;
}
