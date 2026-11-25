/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { gracefulExit } from './cleanup.js';
import { sessionLogger } from '@qwen-code/core';

export async function exitCli(exitCode = 0) {
  sessionLogger.setExitContext({
    reason: exitCode === 0 ? 'success' : 'fatal_error',
    exit_code: exitCode,
    message:
      exitCode === 0
        ? 'CLI exiting normally'
        : `CLI exiting with error code ${exitCode}`,
    source: 'commands.exitCli',
  });
  await gracefulExit(exitCode, {
    exitReason: exitCode === 0 ? 'natural_end' : 'error',
  });
}
