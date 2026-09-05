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
  const issues = error.issues.map((issue) => ({
    code: issue.code,
    path: issue.path.join('.'),
    message: issue.message,
  }));
  const summary = issues
    .slice(0, 3)
    .map(({ path, message }) =>
      `${path || 'options'}: ${message}`.slice(0, 200),
    )
    .join('; ');
  const hint =
    method === 'cua.keypress' || method === 'dom_cua.keypress'
      ? ` Use ${method}({ keys: ["Enter"] }); a chord uses an array such as ["Control", "a"].`
      : method === 'dom_cua.type'
        ? ' Use dom_cua.click({ node_id }) followed by dom_cua.type({ text }) to type at the current focus.'
        : '';
  return new BrowserRuntimeError(
    'INVALID_ARGUMENT',
    `Invalid arguments for ${method}: ${summary}.${hint}`,
    { issues },
  );
}

export function staleSessionError(): BrowserRuntimeError {
  return new BrowserRuntimeError(
    'STALE_BROWSER_SESSION',
    'This Browser Use session is stale; initialize Browser Use and claim the tab again',
  );
}

export function sanitizeOperationError(
  method: string,
  error: unknown,
): BrowserRuntimeError {
  if (error instanceof BrowserRuntimeError) return error;

  const rawMessage = operationErrorMessage(error);
  const message = rawMessage
    ? `${method} failed: ${rawMessage}`
    : `${method} failed`;
  if (/LOCATOR_NOT_UNIQUE|strict mode violation/i.test(rawMessage)) {
    return new BrowserRuntimeError('LOCATOR_NOT_UNIQUE', message);
  }
  if (
    /STALE_TAB|target (page|context|browser).*closed|page has been closed|no tab with id/i.test(
      rawMessage,
    )
  ) {
    return new BrowserRuntimeError('STALE_TAB', message);
  }
  if (/INVALID_LOCATOR|frame was detached/i.test(rawMessage)) {
    return new BrowserRuntimeError('INVALID_LOCATOR', message);
  }
  if (/timeout/i.test(rawMessage)) {
    return new BrowserRuntimeError('OPERATION_TIMEOUT', message);
  }
  if (/selector|locator/i.test(rawMessage)) {
    return new BrowserRuntimeError('INVALID_LOCATOR', message);
  }
  return new BrowserRuntimeError('OPERATION_FAILED', message);
}

function operationErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' &&
          error !== null &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message
        : '';
  return message.trim().slice(0, 4_000);
}
