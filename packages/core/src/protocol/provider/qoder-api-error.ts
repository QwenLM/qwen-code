/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { redactServerErrorText as redactQoderApiSensitiveText } from '../../utils/serverErrorRedaction.js';

export const QODER_API_LOGIN_EXPIRED_CODE = '105';

const GENERIC_QODER_ERROR_CODES = new Set([
  'auth_error',
  'http_error',
  'protocol_error',
  'provider_error',
  'rate_limit',
  'server_error',
  'stream_error',
]);

const KNOWN_QODER_BUSINESS_CODES = new Set([
  '103',
  QODER_API_LOGIN_EXPIRED_CODE,
  '110',
  '112',
  '114',
  '115',
  '116',
  '117',
  '118',
  '119',
  '122',
  '406',
  '430',
  '10605',
  '80411',
  '80412',
  '100400',
  '100401',
  '100403',
]);

export interface ParsedQoderApiErrorBody {
  code?: string;
  message?: string;
  bodyRecord?: Record<string, unknown>;
  subCode?: string;
  modelKey?: string;
  confirmationExpiresAt?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  upstreamErrorType?: string;
}

/** 结构化的服务端错误元数据；挂在失败对象上供展示层透传原始说明。 */
export interface QoderApiErrorDetails {
  source: 'qoder_api';
  subCode?: string;
  modelKey?: string;
  confirmationExpiresAt?: number;
  /** 服务端明确禁止重试时，优先于传输状态的重试推断。 */
  retryable?: boolean;
  status?: string;
  status_code?: number;
  code?: string;
  message?: string;
  body?: string;
  retry_after_ms?: number;
  upstream_error_type?: string;
}

export { redactServerErrorText as redactQoderApiSensitiveText } from '../../utils/serverErrorRedaction.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readCodeString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Whether a code is a transport/provider category rather than a business code. */
export function isGenericErrorCode(value: unknown): boolean {
  const code = readCodeString(value);
  return (
    code !== undefined && GENERIC_QODER_ERROR_CODES.has(code.toLowerCase())
  );
}

export function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

export function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  // Skip the throw/catch on plain human-readable messages — only objects can
  // ever be records, and the SSE error path sees many such strings.
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function collectNestedRecords(
  root: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const seenObjects = new Set<Record<string, unknown>>();
  const seenStrings = new Set<string>();
  const queue: Array<Record<string, unknown>> = [root];

  while (queue.length > 0) {
    const record = queue.shift()!;
    if (seenObjects.has(record)) continue;
    seenObjects.add(record);
    records.push(record);

    for (const key of [
      'error',
      'data',
      'body',
      'message',
      'cause',
      'details',
      'qoderApiError',
      'providerError',
      'responseBody',
    ]) {
      const nested = record[key];
      if (isRecord(nested)) {
        queue.push(nested);
      } else if (typeof nested === 'string' && !seenStrings.has(nested)) {
        seenStrings.add(nested);
        const parsed = parseJsonRecord(nested);
        if (parsed) queue.push(parsed);
      }
    }
  }

  return records;
}

function selectBusinessCode(
  records: ReadonlyArray<Record<string, unknown>>,
): string | undefined {
  const codes = records
    .map((record) => readCodeString(record['code']))
    .filter((code): code is string => code !== undefined);
  // 外层业务码是网关契约；仅通用包装码或 HTTP 状态允许向内查找。
  const outer = codes[0];
  if (
    outer &&
    !isGenericErrorCode(outer) &&
    (!/^\d+$/.test(outer) ||
      Number(outer) < 400 ||
      Number(outer) > 599 ||
      KNOWN_QODER_BUSINESS_CODES.has(outer))
  ) {
    return outer;
  }
  return codes.find((code) => KNOWN_QODER_BUSINESS_CODES.has(code)) ?? outer;
}

function recordForCode(
  records: ReadonlyArray<Record<string, unknown>>,
  code: string | undefined,
): Record<string, unknown> | undefined {
  if (!code) return undefined;
  return records.find((record) => readCodeString(record['code']) === code);
}

export function parseApiErrorBody(
  body: string,
): ParsedQoderApiErrorBody | undefined {
  const bodyRecord = parseJsonRecord(body);
  if (!bodyRecord) return undefined;

  const records = collectNestedRecords(bodyRecord);
  const code = selectBusinessCode(records);
  const selectedRecord = recordForCode(records, code) ?? bodyRecord;
  const message =
    readString(selectedRecord['message']) ?? readString(bodyRecord['message']);
  let retryAfterMs: number | undefined;
  let upstreamErrorType: string | undefined;
  let modelKey: string | undefined;
  let confirmationExpiresAt: number | undefined;
  for (const record of records) {
    retryAfterMs ??=
      readFiniteNumber(record['retry_after_ms']) ??
      readFiniteNumber(record['retryAfterMs']) ??
      (readFiniteNumber(record['retryAfterSeconds']) === undefined
        ? undefined
        : readFiniteNumber(record['retryAfterSeconds'])! * 1000);
    modelKey ??= readString(record['modelKey']);
    confirmationExpiresAt ??= readFiniteNumber(
      record['confirmationExpiresAt'],
    );
    const details = record['details'];
    const detailsRecord = isRecord(details)
      ? details
      : typeof details === 'string'
        ? parseJsonRecord(details)
        : undefined;
    if (detailsRecord) {
      const upstream = isRecord(detailsRecord['error'])
        ? detailsRecord['error']
        : detailsRecord;
      upstreamErrorType ??=
        readString(upstream['type']) ?? readString(upstream['code']);
    }
  }
  return {
    code,
    message,
    bodyRecord,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(upstreamErrorType !== undefined ? { upstreamErrorType } : {}),
    ...(modelKey !== undefined ? { modelKey } : {}),
    ...(confirmationExpiresAt !== undefined
      ? { confirmationExpiresAt }
      : {}),
    ...(records.some(
      (record) => record['subCode'] === 'MODEL_PAID_CONFIRM_REQUIRED',
    )
      ? { subCode: 'MODEL_PAID_CONFIRM_REQUIRED' }
      : {}),
    retryable:
      readBoolean(bodyRecord['retryable']) ??
      readBoolean(selectedRecord['retryable']),
  };
}

/**
 * 把一次 HTTP 失败的响应体整理成结构化错误元数据：业务码与说明单独成字段，
 * 原始 body 脱敏后保留，HTTP 状态不覆盖服务端业务码。
 */
export function buildApiErrorDetails(params: {
  status?: string;
  statusCode?: number;
  body: string;
}): QoderApiErrorDetails {
  const parsed = parseApiErrorBody(params.body);
  return {
    source: 'qoder_api',
    status: params.status,
    status_code: params.statusCode,
    code: parsed?.code,
    ...(parsed?.subCode ? { subCode: parsed.subCode } : {}),
    ...(parsed?.modelKey ? { modelKey: parsed.modelKey } : {}),
    ...(parsed?.confirmationExpiresAt !== undefined
      ? { confirmationExpiresAt: parsed.confirmationExpiresAt }
      : {}),
    ...(parsed?.modelKey ? { modelKey: parsed.modelKey } : {}),
    ...(parsed?.confirmationExpiresAt !== undefined
      ? { confirmationExpiresAt: parsed.confirmationExpiresAt }
      : {}),
    ...(parsed?.retryable !== undefined ? { retryable: parsed.retryable } : {}),
    ...(parsed?.retryAfterMs !== undefined
      ? { retry_after_ms: parsed.retryAfterMs }
      : {}),
    ...(parsed?.upstreamErrorType !== undefined
      ? { upstream_error_type: parsed.upstreamErrorType }
      : {}),
    message:
      parsed?.message === undefined
        ? undefined
        : redactQoderApiSensitiveText(parsed.message),
    body: redactQoderApiSensitiveText(params.body),
  };
}

/** 只信任结构化服务端布尔值；字符串和本地异常字段不改变重试策略。 */
export function isServerRetryDisabled(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (isRecord(current) && !seen.has(current) && seen.size < 16) {
    seen.add(current);
    for (const key of ['qoderApiError', 'providerError']) {
      const details = current[key];
      if (isRecord(details) && details['retryable'] === false) return true;
    }
    current = current['cause'];
  }
  return false;
}

/** A numeric quota code alone never permits a paid resend. */
export function isModelPaidConfirmationRequired(error: unknown): boolean {
  return (
    isRecord(error) &&
    collectNestedRecords(error).some(
      (record) => record['subCode'] === 'MODEL_PAID_CONFIRM_REQUIRED',
    )
  );
}
