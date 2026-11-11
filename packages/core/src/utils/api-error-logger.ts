/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { compactObject } from './error-fields.js';
import { runLogger } from './runLogger.js';

export interface ApiRequestContext {
  operation?: string;
  url: string;
  method: string;
  headers?: Record<string, string>;
  requestStartTime?: number | string | Date;
  durationMs?: number;
}

interface ResponseDetails {
  hasResponse: boolean;
  statusCode?: number | string;
  statusText?: string;
}

const REQUEST_ID_HEADER_NAMES = new Set([
  'x-request-id',
  'x-qoder-request-id',
  'request-id',
]);
const ERROR_CHILD_KEYS = ['cause', 'error', 'reason'] as const;
const NETWORK_ATTEMPT_MESSAGE_MAX_LENGTH = 1024;
const NETWORK_ATTEMPTS_MAX_COUNT = 64;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readStringProperty(
  source: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = source?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

function readBooleanProperty(
  source: Record<string, unknown> | null,
  key: string,
): boolean | undefined {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function getRequestIdFromHeaders(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (!REQUEST_ID_HEADER_NAMES.has(key.toLowerCase())) {
      continue;
    }
    const requestId = value.trim();
    if (requestId) {
      return requestId.toUpperCase();
    }
  }
  return undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function normalizeErrorDetailValue(value: unknown): unknown {
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

function collectErrorRecords(error: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const stack: unknown[] = [error];

  while (stack.length > 0) {
    const current = stack.shift();
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const record = asRecord(current);
    if (!record) continue;

    records.push(record);

    for (const key of ERROR_CHILD_KEYS) {
      const child = record[key];
      if (child) stack.push(child);
    }

    const errors = record['errors'];
    if (Array.isArray(errors)) {
      stack.push(...errors);
    }

    const attemptErrors = record['httpdnsAttemptErrors'];
    if (Array.isArray(attemptErrors)) {
      stack.push(...attemptErrors);
    }
  }

  return records;
}

function getErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<string>();

  for (const record of collectErrorAndResponseRecords(error)) {
    const code = readStringProperty(record, 'code');
    if (code && !seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }

  return codes;
}

function findResponseCandidate(error: unknown): unknown {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current && !seen.has(current)) {
    seen.add(current);
    const record = asRecord(current);
    if (!record) return undefined;
    if (record['response']) return record['response'];
    current = record['cause'];
  }

  return undefined;
}

function collectErrorAndResponseRecords(
  error: unknown,
): Array<Record<string, unknown>> {
  const records = collectErrorRecords(error);
  const response = findResponseCandidate(error);
  if (response) {
    records.push(...collectErrorRecords(response));
  }
  return records;
}

function getNetworkAttemptSummaries(
  error: unknown,
): Array<Record<string, unknown>> {
  const candidates: unknown[] = [];
  const seenArrays = new Set<unknown>();

  for (const record of collectErrorAndResponseRecords(error)) {
    for (const key of ['networkAttempts', 'attempts'] as const) {
      const value = record[key];
      if (!Array.isArray(value) || seenArrays.has(value)) continue;
      if (
        key === 'attempts' &&
        readStringProperty(record, 'name') !== 'NetworkAttemptError'
      ) {
        continue;
      }
      seenArrays.add(value);
      candidates.push(...value);
    }
  }

  return candidates
    .slice(0, NETWORK_ATTEMPTS_MAX_COUNT)
    .map(normalizeNetworkAttempt)
    .filter(
      (attempt): attempt is Record<string, unknown> => attempt !== undefined,
    );
}

function normalizeNetworkAttempt(
  value: unknown,
  fallbackIndex: number,
): Record<string, unknown> | undefined {
  const record = asRecord(value);
  const route = asRecord(record?.['route']);
  if (!record || !route) return undefined;

  const source = readStringProperty(route, 'source');
  const kind = readStringProperty(route, 'kind');
  const hostname = readStringProperty(route, 'hostname');
  if (!source || !kind || !hostname) return undefined;

  const attemptIndex =
    readFiniteNumber(record['attemptIndex']) ?? fallbackIndex;
  const durationMs = readFiniteNumber(record['durationMs']);
  const requestCommitted =
    readBooleanProperty(record, 'requestCommitted') ?? null;
  const rawErrorMessage = readStringProperty(record, 'errorMessage');
  const errorMessage = rawErrorMessage
    ? truncate(rawErrorMessage, NETWORK_ATTEMPT_MESSAGE_MAX_LENGTH)
    : undefined;

  return compactObject({
    attemptIndex,
    route: compactObject({
      kind,
      source,
      endpointOrigin: readStringProperty(route, 'endpointOrigin'),
      hostname,
      ip: readStringProperty(route, 'ip'),
    }),
    status: normalizeErrorDetailValue(record['status']),
    failurePhase: readStringProperty(record, 'failurePhase'),
    errorCode: readStringProperty(record, 'errorCode'),
    errorMessage,
    requestCommitted,
    durationMs,
    nextAction: readStringProperty(record, 'nextAction'),
  });
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Copy route-aware error metadata across Response clones/wrappers.
 *
 * The exported name is retained for compatibility with existing callers.
 */
export function copyHttpdnsErrorMetadata(
  source: unknown,
  target: unknown,
): void {
  const sourceRecord = asRecord(source);
  const targetRecord = asRecord(target);
  if (!sourceRecord || !targetRecord) return;

  const resolvedIp = readStringProperty(sourceRecord, 'resolvedIp');
  if (resolvedIp) {
    targetRecord['resolvedIp'] = resolvedIp;
  }

  const attemptErrors = sourceRecord['httpdnsAttemptErrors'];
  if (Array.isArray(attemptErrors)) {
    targetRecord['httpdnsAttemptErrors'] = attemptErrors;
  }

  const networkAttempts = sourceRecord['networkAttempts'];
  if (Array.isArray(networkAttempts)) {
    targetRecord['networkAttempts'] = networkAttempts;
  }
}

function normalizeStatusCode(
  value: string | undefined,
): number | string | undefined {
  if (value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : value;
}

function extractResponseDetails(error: unknown): ResponseDetails {
  const response = findResponseCandidate(error);
  const responseRecord = asRecord(response);
  const errorRecord = asRecord(error);
  const status =
    readStringProperty(responseRecord, 'status') ??
    readStringProperty(errorRecord, 'status');
  const statusText =
    readStringProperty(responseRecord, 'statusText') ??
    readStringProperty(errorRecord, 'statusText');

  return {
    hasResponse: Boolean(response || status),
    statusCode: normalizeStatusCode(status),
    statusText,
  };
}

function getStatusReason(response: ResponseDetails): string | undefined {
  if (!response.hasResponse || response.statusCode === undefined) {
    return undefined;
  }

  return response.statusText
    ? `${response.statusCode} ${response.statusText}`
    : String(response.statusCode);
}

function getFailureReason(
  errorCode: string | undefined,
  response: ResponseDetails,
  error: unknown,
): string {
  return errorCode ?? getStatusReason(response) ?? getErrorMessage(error);
}

/**
 * Print a concise failed server API request summary.
 *
 * This intentionally writes to stderr so failures are visible even when debug
 * logging is disabled.
 */
export async function logApiError(
  error: unknown,
  requestContext: ApiRequestContext,
): Promise<void> {
  const method = requestContext.method.toUpperCase();
  const response = extractResponseDetails(error);
  const errorCodes = getErrorCodes(error);
  const errorCode = errorCodes[0];
  const networkAttempts = getNetworkAttemptSummaries(error);
  const networkAttemptsJson =
    networkAttempts.length > 0
      ? JSON.stringify(networkAttempts)
      : undefined;
  const reason = getFailureReason(errorCode, response, error);
  const requestId = getRequestIdFromHeaders(requestContext.headers);

  const requestIdSuffix = requestId ? ` requestId=${requestId}` : '';
  runLogger.error(
    `[API Error] ${method} ${requestContext.url} failed: ${reason}${requestIdSuffix}`,
  );
  if (networkAttemptsJson) {
    const operationSuffix = requestContext.operation
      ? ` operation=${JSON.stringify(requestContext.operation)}`
      : '';
    runLogger.error(
      `[API Network Attempts] ${method} ${requestContext.url}${requestIdSuffix}${operationSuffix} attempts=${networkAttemptsJson}`,
    );
  }
}
