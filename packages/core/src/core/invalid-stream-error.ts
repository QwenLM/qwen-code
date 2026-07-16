/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Custom error to signal invalid model stream content that should be retried.
 */
export class InvalidStreamError extends Error {
  readonly type:
    | 'NO_FINISH_REASON'
    | 'NO_RESPONSE_TEXT'
    | 'NO_TOOL_RESULT_PROGRESS'
    | 'PROTOCOL_TAG_LEAK'
    | 'MALFORMED_TOOL_CALL';

  constructor(message: string, type: InvalidStreamError['type']) {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}
