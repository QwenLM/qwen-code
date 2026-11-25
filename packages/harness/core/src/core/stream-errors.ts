/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { StopFailureErrorType } from '../hooks/types.js';
import { getErrorStatus } from '../utils/httpErrors.js';
import {
  MALFORMED_TOOL_USE_CODE,
  MALFORMED_TOOL_USE_EXHAUSTED_CODE,
} from './malformed-tool-use.js';
import { EMPTY_ASSISTANT_COMPLETION_CODE } from '../model-request/empty-assistant-completion.js';

export const MODEL_REFUSAL_ERROR_CODE = 'MODEL_REFUSAL';

function hasErrorCode(err: Error, code: string): boolean {
  return (
    'code' in err &&
    typeof err.code === 'string' &&
    err.code.toUpperCase() === code.toUpperCase()
  );
}

function readErrorCode(err: Error): string | undefined {
  const record = err as Error & {
    code?: unknown;
    errorCode?: unknown;
    type?: unknown;
    providerError?: { code?: unknown };
    qoderApiError?: { code?: unknown };
  };
  const candidate =
    record.code ??
    record.errorCode ??
    record.type ??
    record.providerError?.code ??
    record.qoderApiError?.code;
  return typeof candidate === 'string' ? candidate.toLowerCase() : undefined;
}

export class InvalidStreamError extends Error {
  readonly type:
    | 'NO_FINISH_REASON'
    | 'NO_RESPONSE_TEXT'
    | 'MALFORMED_FUNCTION_CALL'
    | 'UNEXPECTED_TOOL_CALL';

  constructor(
    message: string,
    type:
      | 'NO_FINISH_REASON'
      | 'NO_RESPONSE_TEXT'
      | 'MALFORMED_FUNCTION_CALL'
      | 'UNEXPECTED_TOOL_CALL',
  ) {
    super(message);
    this.name = 'InvalidStreamError';
    this.type = type;
  }
}

/**
 * Classify an error into a StopFailureErrorType for retry notifications and
 * the StopFailure hook.
 */
export function classifyStopFailureError(err: unknown): StopFailureErrorType {
  if (!(err instanceof Error)) return 'unknown';
  if (
    hasErrorCode(err, MALFORMED_TOOL_USE_CODE) ||
    hasErrorCode(err, MALFORMED_TOOL_USE_EXHAUSTED_CODE) ||
    hasErrorCode(err, 'POST_COMPACT_CONTEXT_LIMIT')
  ) {
    return 'invalid_request';
  }
  if (hasErrorCode(err, MODEL_REFUSAL_ERROR_CODE)) {
    return 'invalid_request';
  }
  if (hasErrorCode(err, EMPTY_ASSISTANT_COMPLETION_CODE)) {
    return 'empty_response';
  }

  const code = readErrorCode(err);
  const status = getErrorStatus(err);
  // 已有结构化错误信息时，不让嵌套响应文本覆盖其分类。
  const msg =
    status !== undefined || code !== undefined ? '' : err.message.toLowerCase();
  if (
    code === 'oauth_org_not_allowed' ||
    msg.includes('oauth_org_not_allowed')
  ) {
    return 'oauth_org_not_allowed';
  }
  if (
    code === 'overloaded' ||
    code === 'overloaded_error' ||
    status === 529 ||
    msg.includes('overloaded') ||
    msg.includes('529')
  ) {
    return 'overloaded';
  }
  if (
    err.name === 'ModelNotFoundError' ||
    code === 'model_not_found' ||
    code === 'invalid_model' ||
    status === 404 ||
    msg.includes('model not found') ||
    msg.includes('model_not_found')
  ) {
    return 'model_not_found';
  }
  if (
    code === 'rate_limit' ||
    code === 'rate_limit_error' ||
    status === 429 ||
    msg.includes('rate limit') ||
    msg.includes('429')
  ) {
    return 'rate_limit';
  }
  if (
    code === '105' ||
    code === 'authentication_failed' ||
    code === 'authentication_error' ||
    status === 401 ||
    status === 403 ||
    msg.includes('authentication') ||
    msg.includes('unauthorized') ||
    msg.includes('401')
  ) {
    return 'authentication_failed';
  }
  if (
    code === 'billing_error' ||
    status === 402 ||
    msg.includes('billing') ||
    msg.includes('402')
  ) {
    return 'billing_error';
  }
  if (
    code === 'max_output_tokens' ||
    msg.includes('max_output_tokens') ||
    msg.includes('output token')
  ) {
    return 'max_output_tokens';
  }
  if (
    code === 'invalid_request' ||
    code === 'invalid_request_error' ||
    status === 400 ||
    msg.includes('invalid request') ||
    msg.includes('400')
  ) {
    return 'invalid_request';
  }
  if (
    code === 'server_error' ||
    (status !== undefined && status >= 500) ||
    msg.includes('server error') ||
    /\b50[0-9]\b/.test(msg)
  ) {
    return 'server_error';
  }
  return 'unknown';
}
