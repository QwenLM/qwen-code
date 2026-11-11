/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAbortErrorDeep } from './errors.js';
import { findModelInferenceError } from '../provider/modelInferenceError.js';
import { MAX_OUTPUT_TOKENS_ERROR_CODE } from '../core/max-output-tokens.js';
import { MODEL_NOT_AVAILABLE_ERROR_CODE } from './httpErrors.js';
import {
  getExecutionEnvironmentError,
  EXECUTION_ENVIRONMENT_ERROR_CODES,
} from './fsErrorMessages.js';
import {
  isGenericErrorCode,
  parseApiErrorBody,
} from '../protocol/provider/qoder-api-error.js';

export const RESULT_ERROR_CODES = {
  ...EXECUTION_ENVIRONMENT_ERROR_CODES,
  loginExpired: 105,
  jobTokenInvalid: 'job_token_invalid',
  modelNotAvailable: MODEL_NOT_AVAILABLE_ERROR_CODE,
  todayUsageLimitExceeded: 110,
  usageLimitExceeded: 113,
  freeTrialAccountsExceeded: 114,
  freeUserQuotaLimit: 115,
  teamsAdminCreditsDrainedOut: 116,
  teamsMemberCreditsDrainedOut: 117,
  personalCreditsDrainedOut: 118,
  velaModelFreeLimitReached: 119,
  billingGroupCreditsLimitReached: 122,
  sensitiveContent: 406,
  requestedRangeNotSatisfiable: 416,
  notSupported: 430,
  requestError: 500,
  requestTimeout: 10408,
  serverInternalError: 10500,
  inputContentTooLong: 80411,
  tooManyMedia: 80412,
  modelQueued: 10605,
  hookBlocked: 48716,
  maxTurnsReached: 47902,
  maxOutputTokens: MAX_OUTPUT_TOKENS_ERROR_CODE,
  customModelService: 100400,
  customModelAuth: 100401,
  customModelNotAvailable: 100403,
} as const;

export type ResultErrorCode = number | string;
const SELECTED_RESULT_ERROR_CODES = new Set<ResultErrorCode>(
  Object.values(RESULT_ERROR_CODES),
);
const TERMINAL_QUOTA_RESULT_ERROR_CODES = new Set<number>([
  112,
  RESULT_ERROR_CODES.todayUsageLimitExceeded,
  RESULT_ERROR_CODES.billingGroupCreditsLimitReached,
  RESULT_ERROR_CODES.freeTrialAccountsExceeded,
  RESULT_ERROR_CODES.freeUserQuotaLimit,
  RESULT_ERROR_CODES.teamsAdminCreditsDrainedOut,
  RESULT_ERROR_CODES.teamsMemberCreditsDrainedOut,
  RESULT_ERROR_CODES.personalCreditsDrainedOut,
  RESULT_ERROR_CODES.velaModelFreeLimitReached,
]);

export function isTerminalQuotaResultErrorCode(
  code: ResultErrorCode | undefined,
): boolean {
  return (
    code !== undefined && TERMINAL_QUOTA_RESULT_ERROR_CODES.has(Number(code))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function codeFromRawServerCode(code: unknown): number | undefined {
  return readFiniteNumber(code);
}

function codeFromBusinessCode(code: unknown): string | undefined {
  const value = readString(code);
  if (!value || readFiniteNumber(value) !== undefined) return undefined;
  return isGenericErrorCode(value) ? undefined : value;
}

function codeFromKnownServerCode(code: unknown): number | undefined {
  const codeStr =
    typeof code === 'number'
      ? String(code)
      : typeof code === 'string'
        ? code.trim()
        : undefined;
  if (!codeStr) return undefined;

  switch (codeStr) {
    case '105':
      return RESULT_ERROR_CODES.loginExpired;
    case '110':
      return RESULT_ERROR_CODES.todayUsageLimitExceeded;
    case '112':
      return 112;
    case '114':
      return RESULT_ERROR_CODES.freeTrialAccountsExceeded;
    case '115':
      return RESULT_ERROR_CODES.freeUserQuotaLimit;
    case '116':
      return RESULT_ERROR_CODES.teamsAdminCreditsDrainedOut;
    case '117':
      return RESULT_ERROR_CODES.teamsMemberCreditsDrainedOut;
    case '119':
      return RESULT_ERROR_CODES.velaModelFreeLimitReached;
    case '122':
      return RESULT_ERROR_CODES.billingGroupCreditsLimitReached;
    case '406':
      return RESULT_ERROR_CODES.sensitiveContent;
    case '416':
      return RESULT_ERROR_CODES.requestedRangeNotSatisfiable;
    case '430':
      return RESULT_ERROR_CODES.notSupported;
    case '100400':
      return RESULT_ERROR_CODES.customModelService;
    case '100401':
      return RESULT_ERROR_CODES.customModelAuth;
    case '100403':
      return RESULT_ERROR_CODES.customModelNotAvailable;
    case '10605':
      return RESULT_ERROR_CODES.modelQueued;
    default:
      return undefined;
  }
}

function codeFromSelectedResultCode(
  code: unknown,
): ResultErrorCode | undefined {
  if (typeof code === 'string' && SELECTED_RESULT_ERROR_CODES.has(code)) {
    return code;
  }
  const numericCode = readFiniteNumber(code);
  return numericCode !== undefined &&
    SELECTED_RESULT_ERROR_CODES.has(numericCode)
    ? numericCode
    : undefined;
}

function codeFromSemanticCode(code: unknown): ResultErrorCode | undefined {
  const codeStr = readString(code);
  if (!codeStr) return undefined;

  switch (codeStr) {
    case 'job_token_invalid':
      return RESULT_ERROR_CODES.jobTokenInvalid;
    case 'MODEL_REFUSAL':
      return RESULT_ERROR_CODES.sensitiveContent;
    case 'auth_required':
    case 'auth_expired':
    case 'access_token_invalid':
    case 'job_token_cancelled':
    case 'auth_payload_invalid':
    case 'auth_error':
      return RESULT_ERROR_CODES.loginExpired;
    case 'rate_limit':
      return RESULT_ERROR_CODES.usageLimitExceeded;
    case 'server_error':
      return RESULT_ERROR_CODES.serverInternalError;
    case 'http_error':
      return RESULT_ERROR_CODES.requestError;
    default:
      return undefined;
  }
}

function codeFromTransportCode(code: unknown): number | undefined {
  const codeStr = readString(code)?.toUpperCase();
  if (!codeStr) return undefined;

  switch (codeStr) {
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
      return RESULT_ERROR_CODES.requestTimeout;
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ECONNABORTED':
    case 'EPIPE':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'UND_ERR_SOCKET':
      return RESULT_ERROR_CODES.requestError;
    default:
      return undefined;
  }
}

function codeFromStatus(status: unknown): number | undefined {
  const numericStatus = readFiniteNumber(status);
  if (numericStatus === undefined) return undefined;
  if (numericStatus === 401) {
    return RESULT_ERROR_CODES.loginExpired;
  }
  if (numericStatus === 408) return RESULT_ERROR_CODES.requestTimeout;
  if (numericStatus === 406) return RESULT_ERROR_CODES.sensitiveContent;
  if (numericStatus === 416) {
    return RESULT_ERROR_CODES.requestedRangeNotSatisfiable;
  }
  if (numericStatus === 413) return RESULT_ERROR_CODES.inputContentTooLong;
  if (numericStatus === 429) return RESULT_ERROR_CODES.usageLimitExceeded;
  // 仅 HTTP 5xx 归一为服务端错误，避免吞掉 101400 等业务码。
  if (numericStatus >= 500 && numericStatus <= 599) {
    return RESULT_ERROR_CODES.serverInternalError;
  }
  return undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function apiErrorBodyFromMessage(message: string): string | undefined {
  const qoderApiMatch = /^Qoder API error:\s*[^-]+-\s*(.*)$/s.exec(message);
  return qoderApiMatch?.[1]?.trim();
}

function jsonBodyFromMessage(
  message: string,
): Record<string, unknown> | undefined {
  return parseJsonObject(
    apiErrorBodyFromMessage(message) ?? message.trim(),
  );
}

function codeFromParsedApiBody(
  body: NonNullable<ReturnType<typeof parseApiErrorBody>>,
): ResultErrorCode | undefined {
  const qoderCode =
    codeFromKnownServerCode(body.code) ??
    codeFromSelectedResultCode(body.code) ??
    codeFromStatus(body.code);
  if (qoderCode !== undefined) return qoderCode;

  const rawServerCode = codeFromRawServerCode(body.code);
  if (rawServerCode !== undefined) return rawServerCode;

  const businessCode = codeFromBusinessCode(body.code);
  if (businessCode !== undefined) return businessCode;

  return codeFromRecord(body.bodyRecord ?? {});
}

function codeFromApiBodyText(body: string): ResultErrorCode | undefined {
  const parsedBody = parseApiErrorBody(body);
  return parsedBody ? codeFromParsedApiBody(parsedBody) : undefined;
}

function codeFromJsonLikeString(value: unknown): ResultErrorCode | undefined {
  if (typeof value !== 'string') return undefined;

  const qoderApiBodyCode = codeFromApiBodyText(
    apiErrorBodyFromMessage(value) ?? value,
  );
  if (qoderApiBodyCode !== undefined) return qoderApiBodyCode;

  const parsed = jsonBodyFromMessage(value);
  return parsed ? codeFromRecord(parsed) : undefined;
}

function hasExplicitServerCode(record: Record<string, unknown>): boolean {
  const code = readString(record['code']);
  return code !== undefined && !isGenericErrorCode(code);
}

function codeFromProviderErrorRecord(
  record: Record<string, unknown>,
): ResultErrorCode | undefined {
  const serverCode =
    codeFromSelectedResultCode(record['code']) ??
    codeFromKnownServerCode(record['code']);
  if (serverCode !== undefined) return serverCode;

  const rawServerCode = codeFromRawServerCode(record['code']);
  if (
    rawServerCode !== undefined &&
    (rawServerCode < 400 || rawServerCode > 599)
  )
    return rawServerCode;

  const businessCode = codeFromBusinessCode(record['code']);
  if (businessCode !== undefined) return businessCode;

  const nestedMessageCode =
    codeFromJsonLikeString(record['message']) ??
    codeFromJsonLikeString(record['body']);
  if (nestedMessageCode !== undefined) return nestedMessageCode;

  if (rawServerCode !== undefined) return rawServerCode;

  if (hasExplicitServerCode(record)) return undefined;
  return (
    codeFromStatus(record['status_code']) ??
    codeFromStatus(record['statusCode']) ??
    codeFromStatus(record['httpStatus']) ??
    codeFromStatus(record['status'])
  );
}

function codeFromRecord(
  record: Record<string, unknown>,
): ResultErrorCode | undefined {
  const explicitCode =
    codeFromSelectedResultCode(record['errCode']) ??
    codeFromSelectedResultCode(record['error_code']) ??
    codeFromSelectedResultCode(record['errorCode']) ??
    codeFromKnownServerCode(record['errCode']) ??
    codeFromKnownServerCode(record['error_code']) ??
    codeFromKnownServerCode(record['errorCode']);
  if (explicitCode !== undefined) return explicitCode;

  if ('providerCode' in record || 'providerStatus' in record) {
    const providerCode = codeFromProviderErrorRecord({
      code: record['providerCode'],
      status_code: record['providerStatus'],
    });
    if (providerCode !== undefined) return providerCode;
  }

  // Retain original metadata for errors and transcripts predating the Provider.
  for (const key of ['qoderApiError', 'providerError']) {
    const value = record[key];
    const details = isRecord(value)
      ? value
      : typeof value === 'string'
        ? jsonBodyFromMessage(value)
        : undefined;
    if (details) {
      const providerCode = codeFromProviderErrorRecord(details);
      if (providerCode !== undefined) return providerCode;
    }
  }

  const serverCode =
    codeFromSelectedResultCode(record['code']) ??
    codeFromKnownServerCode(record['code']);
  if (serverCode !== undefined) return serverCode;

  const nestedMessageCode =
    codeFromJsonLikeString(record['message']) ??
    codeFromJsonLikeString(record['body']);
  if (nestedMessageCode !== undefined) return nestedMessageCode;

  const statusCode =
    codeFromStatus(record['status_code']) ??
    codeFromStatus(record['statusCode']) ??
    codeFromStatus(record['httpStatus']) ??
    codeFromStatus(record['status']);
  if (statusCode !== undefined) return statusCode;

  for (const key of ['error', 'data', 'body', 'cause']) {
    const nested = record[key];
    if (isRecord(nested)) {
      const nestedCode = codeFromRecord(nested);
      if (nestedCode !== undefined) return nestedCode;
    } else if (typeof nested === 'string') {
      const parsed = jsonBodyFromMessage(nested);
      if (parsed) {
        const parsedCode = codeFromRecord(parsed);
        if (parsedCode !== undefined) return parsedCode;
      }
    }
  }

  const transportCode =
    codeFromTransportCode(record['code']) ??
    codeFromTransportCode(record['errno']) ??
    codeFromTransportCode(record['normalized_code']);
  if (transportCode !== undefined) return transportCode;

  const semanticCode = codeFromSemanticCode(record['code']);
  if (
    semanticCode === RESULT_ERROR_CODES.loginExpired &&
    (readFiniteNumber(record['status']) === 403 ||
      readFiniteNumber(record['httpStatus']) === 403 ||
      readFiniteNumber(record['status_code']) === 403 ||
      readFiniteNumber(record['statusCode']) === 403)
  ) {
    return undefined;
  }
  return semanticCode ?? codeFromStatus(record['code']);
}

function codeFromMessage(
  message: string,
  classifyEnvironment = true,
): ResultErrorCode | undefined {
  const environmentError = classifyEnvironment
    ? getExecutionEnvironmentError(message)
    : undefined;
  if (environmentError) return environmentError.code;
  const jsonLikeCode = codeFromJsonLikeString(message);
  if (jsonLikeCode !== undefined) return jsonLikeCode;

  const lower = message.toLowerCase();
  const statusMatch =
    /\b(?:http|status|status_code|status code|request failed)[:=\s-]*(\d{3})\b/i.exec(
      message,
    );
  if (statusMatch?.[1]) {
    const statusCode = codeFromStatus(statusMatch[1]);
    if (statusCode !== undefined) return statusCode;
  }

  if (message.includes('Billing daily count exceeded')) {
    return RESULT_ERROR_CODES.todayUsageLimitExceeded;
  }
  if (message.includes('User quota exhausted')) {
    return RESULT_ERROR_CODES.usageLimitExceeded;
  }
  if (message.includes('Session blocked')) {
    return RESULT_ERROR_CODES.sensitiveContent;
  }
  if (
    lower.includes('input is too long for requested model') ||
    lower.includes('prompt is too long') ||
    lower.includes('context_length_exceeded') ||
    lower.includes('context exceeds the limit')
  ) {
    return RESULT_ERROR_CODES.inputContentTooLong;
  }
  if (message.includes('too many images and documents')) {
    return RESULT_ERROR_CODES.tooManyMedia;
  }
  if (
    message.includes('105') &&
    (message.includes('Login timeout') || message.includes('Login expired'))
  ) {
    return RESULT_ERROR_CODES.loginExpired;
  }
  if (message.includes('114') && message.includes('pricingUrl')) {
    return RESULT_ERROR_CODES.freeTrialAccountsExceeded;
  }
  if (message.includes('112') && message.includes('pricingUrl')) {
    return 112;
  }
  if (message.includes('122') && message.includes('Billing Group')) {
    return RESULT_ERROR_CODES.billingGroupCreditsLimitReached;
  }
  if (message.includes('116') && message.includes('purchaseUrl')) {
    return RESULT_ERROR_CODES.teamsAdminCreditsDrainedOut;
  }
  if (message.includes('117') && message.includes('usageUrl')) {
    return RESULT_ERROR_CODES.teamsMemberCreditsDrainedOut;
  }
  if (message.includes('430') && message.includes('update')) {
    return RESULT_ERROR_CODES.notSupported;
  }
  if (
    message === 'Maximum turns exceeded' ||
    message.startsWith('Reached maximum number of turns')
  ) {
    return RESULT_ERROR_CODES.maxTurnsReached;
  }
  if (message === 'Agent execution blocked by hook') {
    return RESULT_ERROR_CODES.hookBlocked;
  }
  if (message.startsWith('Operation stopped by hook')) {
    return RESULT_ERROR_CODES.hookBlocked;
  }
  if (
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('etimedout') ||
    lower.includes('und_err_connect_timeout') ||
    lower.includes('und_err_headers_timeout') ||
    lower.includes('und_err_body_timeout')
  ) {
    return RESULT_ERROR_CODES.requestTimeout;
  }
  if (
    lower.includes('request failed') ||
    lower.includes('fetch failed') ||
    lower.includes('network error') ||
    lower.includes('socket hang up') ||
    lower.includes('socket reset') ||
    lower.includes('connection reset') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('econnaborted') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('epipe') ||
    lower.includes('ehostunreach') ||
    lower.includes('enetunreach') ||
    lower.includes('und_err_socket')
  ) {
    return RESULT_ERROR_CODES.requestError;
  }
  return undefined;
}

export function getResultErrorCode(
  error: unknown,
): ResultErrorCode | undefined {
  if (isAbortErrorDeep(error)) return undefined;

  // Provider owns model error identity, including the absence of a code.
  const inferenceError = findModelInferenceError(error);
  if (inferenceError) return inferenceError.code;

  return getErrorDisplayCode(error);
}

/** Legacy error classification for UI text; never changes the original error. */
export function getErrorDisplayCode(
  error: unknown,
): ResultErrorCode | undefined {
  if (isAbortErrorDeep(error)) return undefined;

  const environmentError = getExecutionEnvironmentError(error);
  if (environmentError) return environmentError.code;

  if (isRecord(error)) {
    const recordCode = codeFromRecord(error);
    if (recordCode !== undefined) return recordCode;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : undefined;
  // 对象已按完整的系统调用信息分类，不能丢掉上下文后再次仅凭文本分类。
  return message ? codeFromMessage(message, false) : undefined;
}

export function getResultErrorCodeFromMessages(
  messages: readonly string[],
): ResultErrorCode | undefined {
  for (const message of messages) {
    const code = codeFromMessage(message);
    if (code !== undefined) return code;
  }
  return undefined;
}
