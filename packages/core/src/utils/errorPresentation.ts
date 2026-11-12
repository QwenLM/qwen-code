/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  getApiErrorDisplayMetadata,
  INVALID_MODEL_RESPONSE_MESSAGE,
  CONNECTION_INTERRUPTED_MESSAGE,
} from './errorParsing.js';
import {
  getResultErrorCode,
  getErrorDisplayCode,
  getResultErrorCodeFromMessages,
  RESULT_ERROR_CODES,
  type ResultErrorCode,
} from './resultErrorCode.js';
import { isAbortErrorDeep, collectErrorCodes } from './errors.js';
import { QODER_PROVIDER_ID } from '../provider/modelProvider.js';
import { getQoderErrorText } from '../provider/qoder/qoderErrorText.js';
import { getExecutionEnvironmentError } from './fsErrorMessages.js';
import { getErrorStatus } from './httpErrors.js';
import { getServerErrorMessage } from './serverErrorMessage.js';
import {
  findModelInferenceError,
  type ModelInferenceErrorKind,
} from '../provider/modelInferenceError.js';
import { CONTENT_FILTERED_MESSAGE } from '../core/query-event.js';
import { getI18nService } from '../i18n/index.js';
import {
  MAX_OUTPUT_TOKENS_ERROR_CODE,
  MAX_OUTPUT_TOKENS_MESSAGE,
} from '../core/max-output-tokens.js';
import {
  EMPTY_ASSISTANT_COMPLETION_CODE,
  findEmptyAssistantCompletionError,
  type EmptyAssistantCompletionReason,
} from '../model-request/empty-assistant-completion.js';

export { getServerErrorMessage } from './serverErrorMessage.js';

export { INVALID_MODEL_RESPONSE_MESSAGE } from './errorParsing.js';

export const REQUEST_FAILED_MESSAGE =
  'The request could not be completed. Please try again.';

/**
 * A protocol-complete but semantically-empty completion is a model-output
 * quality failure, not a service outage. Show a dedicated, actionable message
 * instead of the generic 500 text so users can tell the two apart.
 */
export const EMPTY_ASSISTANT_COMPLETION_MESSAGES: Readonly<
  Record<EmptyAssistantCompletionReason, string>
> = {
  reasoning_only:
    'The model finished its reasoning but returned no answer or tool call. Please try again or switch models.',
  no_visible_content:
    'The model returned an empty response. Please try again or switch models.',
};

export const REQUEST_REJECTED_MESSAGE =
  'The model service rejected this request. Please check the request and try again.';

export const REPEATED_TOOL_CALL_STOPPED_ERROR_CODE =
  'REPEATED_TOOL_CALL_STOPPED';

const ERROR_FALLBACK_MESSAGES: Readonly<Record<number, string>> = {
  400: REQUEST_REJECTED_MESSAGE,
  401: 'Your authentication has expired. Please sign in again.',
  403: 'You do not have access to this model service. Please check your account permissions.',
  406: CONTENT_FILTERED_MESSAGE,
  408: 'The model service did not respond in time. Please try again.',
  416: 'The model service could not process this request.',
  429: 'The request limit has been reached. Please try again later.',
  430: 'This operation is not supported. Please check your CLI version and model configuration.',
  500: REQUEST_FAILED_MESSAGE,
  10408: 'The model service did not respond in time. Please try again.',
  10500:
    'The model service is temporarily unavailable. Please try again later.',
  48716: 'Agent execution blocked by hook',
  47902: 'Reached maximum number of turns',
  100400:
    'The custom model service could not process the request. Please check its configuration.',
  100401:
    'Authentication to the custom model service failed. Please check its credentials.',
  100403:
    'The custom model is unavailable. Please check its configuration and access permissions.',
};

const MODEL_ERROR_MESSAGES: Readonly<Record<ModelInferenceErrorKind, string>> = {
  prompt_too_long:
    'The input is too long for this model. Please shorten it or start a new conversation.',
  quota_exhausted:
    'The model service quota has been exhausted. Please check your provider usage and limits.',
  auth: ERROR_FALLBACK_MESSAGES[100401],
  rate_limited: ERROR_FALLBACK_MESSAGES[429],
  model_not_found:
    'The model could not be found. Please check the model name and availability.',
  invalid_request: REQUEST_REJECTED_MESSAGE,
  server: ERROR_FALLBACK_MESSAGES[10500],
  network: CONNECTION_INTERRUPTED_MESSAGE,
  protocol: INVALID_MODEL_RESPONSE_MESSAGE,
  unknown: REQUEST_FAILED_MESSAGE,
};

/** Host-only: select text for an existing error code without changing it. */
export function getErrorCodeFallbackMessage(
  code: ResultErrorCode | undefined,
  kind: ModelInferenceErrorKind = 'unknown',
  details?: {
    providerSource?: string;
    status?: number;
    message?: string;
    emptyCompletionReason?: EmptyAssistantCompletionReason;
    causeCodes?: readonly string[];
  },
): string {
  if (code === MAX_OUTPUT_TOKENS_ERROR_CODE) return MAX_OUTPUT_TOKENS_MESSAGE;
  if (details?.emptyCompletionReason) {
    return EMPTY_ASSISTANT_COMPLETION_MESSAGES[details.emptyCompletionReason];
  }
  if (
    details?.causeCodes &&
    getApiErrorDisplayMetadata({
      errors: details.causeCodes.map((causeCode) => ({ code: causeCode })),
    })?.fallbackMessage === CONNECTION_INTERRUPTED_MESSAGE
  )
    return CONNECTION_INTERRUPTED_MESSAGE;
  if (kind === 'protocol') return INVALID_MODEL_RESPONSE_MESSAGE;
  if (details?.providerSource === QODER_PROVIDER_ID) {
    const qoderMessage = (value: ResultErrorCode | undefined) =>
      getQoderErrorText(value, getI18nService()?.locale) ??
      ERROR_FALLBACK_MESSAGES[Number(value)];
    const codeMessage =
      qoderMessage(code) ?? qoderMessage(getErrorDisplayCode({ code }));
    if (codeMessage !== undefined) return codeMessage;
    const statusCode = getErrorDisplayCode({ status: details.status });
    const causeCode = details.causeCodes
      ?.map((cause) => getErrorDisplayCode({ code: cause }))
      .find(
        (cause) =>
          cause !== undefined && cause !== RESULT_ERROR_CODES.requestError,
      );
    const messageCode = getErrorDisplayCode(details.message);
    const qoderText =
      qoderMessage(statusCode ?? details.status) ??
      qoderMessage(causeCode) ??
      qoderMessage(messageCode);
    if (qoderText !== undefined) return qoderText;
  }
  if (kind === 'auth' && details?.status === 403) {
    return ERROR_FALLBACK_MESSAGES[403];
  }
  if (kind === 'invalid_request' && details?.status === 406) {
    return CONTENT_FILTERED_MESSAGE;
  }
  if (
    details?.status === 408 ||
    (kind === 'network' &&
      details?.causeCodes?.some(
        (cause) =>
          getErrorDisplayCode({ errno: cause }) ===
          RESULT_ERROR_CODES.requestTimeout,
      ))
  ) {
    return ERROR_FALLBACK_MESSAGES[408];
  }
  return MODEL_ERROR_MESSAGES[kind];
}

/** Host-only: choose UI text without changing the Provider error. */
export function resolveErrorPresentation(
  error: unknown,
  providerSource?: string,
): {
  displayErrorCode?: string | number;
  fallbackMessage: string;
} {
  if (isAbortErrorDeep(error)) {
    return { fallbackMessage: 'Operation aborted' };
  }
  const inferenceError = findModelInferenceError(error);
  if (inferenceError) {
    const emptyCompletion = findEmptyAssistantCompletionError(error);
    const metadata = getApiErrorDisplayMetadata(error);
    return {
      ...(inferenceError.code !== undefined
        ? { displayErrorCode: inferenceError.code }
        : {}),
      fallbackMessage: emptyCompletion
        ? EMPTY_ASSISTANT_COMPLETION_MESSAGES[emptyCompletion.reason]
        : metadata?.fallbackMessage === CONNECTION_INTERRUPTED_MESSAGE
          ? CONNECTION_INTERRUPTED_MESSAGE
          : getErrorCodeFallbackMessage(
              inferenceError.code,
              inferenceError.kind,
              {
                providerSource,
                status: inferenceError.status,
                causeCodes: collectErrorCodes(error),
                message: inferenceError.message,
              },
            ),
    };
  }
  const environmentError = getExecutionEnvironmentError(error);
  if (environmentError) {
    return {
      displayErrorCode: environmentError.code,
      fallbackMessage: environmentError.message,
    };
  }
  const metadata = getApiErrorDisplayMetadata(error);
  const code = getResultErrorCode(error);
  if (code === MAX_OUTPUT_TOKENS_ERROR_CODE) {
    return {
      displayErrorCode: MAX_OUTPUT_TOKENS_ERROR_CODE,
      fallbackMessage: MAX_OUTPUT_TOKENS_MESSAGE,
    };
  }
  const emptyCompletion = findEmptyAssistantCompletionError(error);
  if (emptyCompletion) {
    // Keep the dedicated code out of the generic-500 bucket: the remote
    // error-code catalog owns the 500 text and would replace the specific
    // message with the generic "something went wrong" wording.
    return {
      displayErrorCode: EMPTY_ASSISTANT_COMPLETION_CODE,
      fallbackMessage:
        EMPTY_ASSISTANT_COMPLETION_MESSAGES[emptyCompletion.reason] ??
        EMPTY_ASSISTANT_COMPLETION_MESSAGES.no_visible_content,
    };
  }
  if (
    metadata?.displayErrorCode === undefined &&
    metadata?.fallbackMessage === CONNECTION_INTERRUPTED_MESSAGE
  ) {
    return { fallbackMessage: CONNECTION_INTERRUPTED_MESSAGE };
  }
  const displayErrorCode =
    metadata?.displayErrorCode ??
    (code !== undefined && code !== 500 ? code : getErrorStatus(error)) ??
    code ??
    500;
  const fallbackCode =
    code !== undefined && code !== 500 ? code : Number(displayErrorCode);
  const fallbackMessage =
    (typeof fallbackCode === 'number'
      // Legacy 406 also represents model refusal; Qoder's guidance requires
      // the Provider-aware path above rather than the numeric code alone.
      ? (fallbackCode !== 406 ? getQoderErrorText(fallbackCode) : undefined) ??
        ERROR_FALLBACK_MESSAGES[fallbackCode]
      : undefined) ?? REQUEST_FAILED_MESSAGE;
  return { displayErrorCode, fallbackMessage };
}

export interface ErrorResultFields {
  type: string;
  subtype?: string;
  is_error?: boolean;
  errors?: string[];
  error_code?: ResultErrorCode;
  error_message?: string;
  terminal_reason?: string | null;
}

/** 为所有失败 result 补齐协议兜底，保留业务文案、扩展字段和取消语义。 */
export function normalizeSdkErrorResult<T extends ErrorResultFields>(
  result: T,
  error?: unknown,
): T {
  if (result.type !== 'result' || result.subtype === 'success') return result;
  const interrupted =
    result.terminal_reason === 'aborted_streaming' ||
    result.terminal_reason === 'aborted_tools';
  const inferenceError = findModelInferenceError(error);
  const errors = (result.errors ?? [])
    .filter(
      (text) =>
        typeof text === 'string' &&
        text.trim().length > 0 &&
        !['Unknown error', '[object Object]', 'undefined', 'null'].includes(
          text.trim(),
        ),
    )
    .map((text) =>
      inferenceError
        ? text
        : ((interrupted
            ? undefined
            : getExecutionEnvironmentError(text)?.message) ??
          (text.startsWith('Malformed tool call stream:')
            ? INVALID_MODEL_RESPONSE_MESSAGE
            : text)),
    );
  const cancelled =
    interrupted ||
    isAbortErrorDeep(error) ||
    (errors.length > 0 &&
      errors.every((text) =>
        /^Operation (aborted|cancelled)\.?$/i.test(text.trim()),
      ));
  const errorCode = inferenceError
    ? cancelled
      ? undefined
      : inferenceError.code
    : (((typeof result.error_code === 'number' &&
        Number.isFinite(result.error_code)) ||
      (typeof result.error_code === 'string' &&
        result.error_code.trim().length > 0)
        ? result.error_code
        : undefined) ??
      (cancelled ? undefined : getResultErrorCodeFromMessages(errors)) ??
      (result.terminal_reason === 'repeated_tool_call_denied'
        ? REPEATED_TOOL_CALL_STOPPED_ERROR_CODE
        : result.subtype === 'error_max_turns'
          ? RESULT_ERROR_CODES.maxTurnsReached
          : cancelled
            ? undefined
            : RESULT_ERROR_CODES.requestError));
  const errorMessage = getServerErrorMessage(error);
  const normalized = {
    ...result,
    ...(errorMessage !== undefined ? { error_message: errorMessage } : {}),
    errors:
      errors.length > 0
        ? errors
        : [
            cancelled
              ? 'Operation aborted'
              : (getExecutionEnvironmentError({ code: errorCode })?.message ??
                REQUEST_FAILED_MESSAGE),
          ],
  };
  if (errorCode === undefined) {
    delete normalized.error_code;
  } else {
    normalized.error_code = errorCode;
  }
  return normalized;
}

export interface TurnFailureResult {
  type: 'result';
  subtype: 'error_during_execution';
  is_error: true;
  result: string;
  errors: string[];
  error_message?: string;
  error_code?: ResultErrorCode;
  session_id: string;
  uuid: string;
}

/**
 * `turnFailed` 的 result 帧：宿主在 turn 级异常（例如 transcript 写入失败）时
 * 没有正常的 result，只能合成一个终态。`result` 保留原始文案给旧消费方；
 * `errors` 是协议里的展示字段，纯文本渲染只读它——缺了这个字段，任何具体错误
 * 都会退化成 `Unknown error`。
 */
export function buildTurnFailureResult(
  sessionId: string,
  error: unknown,
): TurnFailureResult {
  const message = error instanceof Error ? error.message : String(error);
  const serverMessage = getServerErrorMessage(error);
  const errorCode = getResultErrorCode(error);
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: message,
    errors: message.trim().length > 0 ? [message] : ['Unknown error'],
    ...(serverMessage !== undefined ? { error_message: serverMessage } : {}),
    ...(errorCode !== undefined ? { error_code: errorCode } : {}),
    session_id: sessionId,
    uuid: randomUUID(),
  };
}
