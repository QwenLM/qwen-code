/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ZodError } from 'zod';
import { BrowserRuntimeError } from '../bridge/index.js';

export { BrowserRuntimeError, type RuntimeErrorCode } from '../bridge/index.js';

export function invalidArguments(
  method: string,
  error: ZodError,
): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'INVALID_ARGUMENT',
    `Invalid arguments for ${method}`,
    {
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.join('.'),
      })),
    },
  );
}

export function sanitizeOperationError(
  method: string,
  error: unknown,
): BrowserRuntimeError {
  if (error instanceof BrowserRuntimeError) return error;

  const rawMessage = error instanceof Error ? error.message : '';
  if (/LOCATOR_NOT_UNIQUE|strict mode violation/i.test(rawMessage)) {
    return new BrowserRuntimeError(
      'LOCATOR_NOT_UNIQUE',
      `${method} matched more than one element`,
    );
  }
  if (/timeout/i.test(rawMessage)) {
    return new BrowserRuntimeError('OPERATION_TIMEOUT', `${method} timed out`);
  }
  if (
    /STALE_TAB|target (page|context|browser).*closed|page has been closed|no tab with id/i.test(
      rawMessage,
    )
  ) {
    return new BrowserRuntimeError(
      'STALE_TAB',
      `${method} cannot use a closed or stale tab`,
    );
  }
  if (/INVALID_LOCATOR|frame was detached/i.test(rawMessage)) {
    return new BrowserRuntimeError(
      'INVALID_LOCATOR',
      `${method} used a detached frame; rebuild the locator`,
    );
  }
  if (/selector|locator/i.test(rawMessage)) {
    return new BrowserRuntimeError(
      'INVALID_LOCATOR',
      `${method} could not resolve its locator plan`,
    );
  }
  return new BrowserRuntimeError('OPERATION_FAILED', `${method} failed`);
}
