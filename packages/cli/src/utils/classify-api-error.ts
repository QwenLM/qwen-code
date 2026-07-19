/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StopFailureErrorType } from '@qwen-code/qwen-code-core';

export function classifyApiError(error: {
  message: string;
  status?: number;
}): StopFailureErrorType {
  const status = error.status;
  const message = error.message?.toLowerCase() ?? '';

  if (status === 429 || message.includes('rate limit')) {
    return 'rate_limit';
  }
  if (status === 401 || message.includes('unauthorized')) {
    return 'authentication_failed';
  }
  if (
    status === 402 ||
    status === 403 ||
    message.includes('billing') ||
    message.includes('quota')
  ) {
    return 'billing_error';
  }
  if (status === 400 || message.includes('invalid')) {
    return 'invalid_request';
  }
  if (status !== undefined && status >= 500) {
    return 'server_error';
  }
  if (message.includes('max_tokens') || message.includes('token limit')) {
    return 'max_output_tokens';
  }
  return 'unknown';
}
