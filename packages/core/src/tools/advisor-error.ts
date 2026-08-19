/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getErrorMessage,
  getErrorStatus,
  getErrorType,
} from '../utils/errors.js';

export type AdvisorErrorCode =
  | 'disabled'
  | 'model_not_found'
  | 'provider_auth'
  | 'too_many_requests'
  | 'overloaded'
  | 'unavailable'
  | 'prompt_too_long'
  | 'execution_time_exceeded'
  | 'invalid_response'
  | 'max_uses_exceeded'
  | 'invalid_call_order'
  | 'missing_prompt_context'
  | 'incomplete_transcript';

function normalizeStatus(
  status: number | string | undefined,
): number | undefined {
  if (typeof status === 'number') return status;
  if (typeof status !== 'string') return undefined;
  const parsed = Number(status);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function mapAdvisorApiError(params: {
  statusCode?: number | string;
  errorMessage?: string;
  errorType?: string;
}): AdvisorErrorCode {
  const status = normalizeStatus(params.statusCode);
  if (status === 401 || status === 403) return 'provider_auth';
  if (status === 429) return 'too_many_requests';
  if (status === 408 || status === 504) return 'execution_time_exceeded';
  if (status === 503 || status === 529) return 'overloaded';
  if (status && status >= 500) return 'unavailable';

  const message = (params.errorMessage ?? '').toLowerCase();
  const type = (params.errorType ?? '').toLowerCase();
  if (message.includes('context') && message.includes('long')) {
    return 'prompt_too_long';
  }
  if (message.includes('not found') || message.includes('not registered')) {
    return 'model_not_found';
  }
  if (message.includes('auth') || message.includes('credential')) {
    return 'provider_auth';
  }
  if (message.includes('timeout') || type.includes('timeout')) {
    return 'execution_time_exceeded';
  }
  if (message.includes('empty response')) {
    return 'invalid_response';
  }
  return 'unavailable';
}

export function mapAdvisorError(error: unknown): AdvisorErrorCode {
  return mapAdvisorApiError({
    statusCode: getErrorStatus(error),
    errorMessage: getErrorMessage(error),
    errorType: getErrorType(error),
  });
}
