/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type RuntimeErrorCode =
  | 'BROWSER_DISCONNECTED'
  | 'CONCURRENT_TAB_OPERATION'
  | 'DIALOG_OPEN'
  | 'INPUT_BLOCKED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_LOCATOR'
  | 'LOCATOR_NOT_UNIQUE'
  | 'NAVIGATION_BLOCKED'
  | 'NOT_FOUND'
  | 'NOT_RUNNING'
  | 'OPERATION_FAILED'
  | 'OPERATION_TIMEOUT'
  | 'STALE_TAB'
  | 'TAB_ALREADY_CLAIMED'
  | 'TAB_NOT_GRANTED'
  | 'TAB_NOT_OWNED'
  | 'TRANSPORT_UNAVAILABLE'
  | 'UNKNOWN_METHOD'
  | 'UNSUPPORTED_TAB'
  | 'UPLOAD_BLOCKED';

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
