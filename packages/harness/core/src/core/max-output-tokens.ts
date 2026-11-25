/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_OUTPUT_TOKENS_ERROR_CODE = 'max_output_tokens';
export const MAX_OUTPUT_TOKENS_MESSAGE =
  'The model reached its output token limit and the response is incomplete. Please try again or break the task into smaller parts.';

/** 输出上限导致的终态错误，保留原始原因和用户主动重试的入口。 */
export class MaxOutputTokensError extends Error {
  readonly code = MAX_OUTPUT_TOKENS_ERROR_CODE;
  readonly error_code = MAX_OUTPUT_TOKENS_ERROR_CODE;
  readonly retryable = false;
  readonly stopReason = 'max_tokens';

  constructor(options?: ErrorOptions) {
    super(MAX_OUTPUT_TOKENS_MESSAGE, options);
    this.name = 'MaxOutputTokensError';
  }
}
