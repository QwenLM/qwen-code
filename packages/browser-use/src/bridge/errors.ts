/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type RuntimeErrorCode =
  | 'BROWSER_DISCONNECTED'
  | 'BROWSER_USE_BUSY'
  | 'DIALOG_OPEN'
  | 'INVALID_ARGUMENT'
  | 'INVALID_LOCATOR'
  | 'INPUT_BLOCKED'
  | 'LOCATOR_NOT_UNIQUE'
  | 'NOT_FOUND'
  | 'NOT_RUNNING'
  | 'OPERATION_FAILED'
  | 'OPERATION_TIMEOUT'
  | 'PERMISSION_REQUIRED'
  | 'STALE_TAB'
  | 'STALE_BROWSER_SESSION'
  | 'TAB_NOT_GRANTED'
  | 'TRANSPORT_UNAVAILABLE'
  | 'UNKNOWN_METHOD'
  | 'UNSUPPORTED_TAB';

export class BrowserRuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: RuntimeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'BrowserRuntimeError';
    this.code = code;
    this.details = details;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}
