/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ExitCodes, sessionLogger } from '@qwen-code/core';
import { runExitCleanupWithTimeout } from '../../utils/cleanup.js';

export async function exitSuccessfully(
  message: string,
  source: string,
): Promise<never> {
  await runExitCleanupWithTimeout();
  sessionLogger.setExitContext({
    reason: 'success',
    exit_code: ExitCodes.SUCCESS,
    message,
    source,
  });
  process.exit(ExitCodes.SUCCESS);
}

export async function exitWithInputError(
  message: string,
  source: string,
): Promise<never> {
  await runExitCleanupWithTimeout();
  sessionLogger.setExitContext({
    reason: 'input_error',
    exit_code: ExitCodes.FATAL_INPUT_ERROR,
    message,
    source,
  });
  process.exit(ExitCodes.FATAL_INPUT_ERROR);
}
