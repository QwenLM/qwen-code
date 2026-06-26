/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { isAbortError } from './errors.js';
import { isQwenQuotaExceededError } from './quotaErrorDetection.js';
import { getRateLimitErrorDetails, isRateLimitError } from './rateLimit.js';

export type RetryErrorKind =
  | 'http'
  | 'sse-provider'
  | 'provider'
  | 'transport'
  | 'abort'
  | 'provider-business'
  | 'unknown';

export type RetryErrorDiagnosis =
  | 'retryable'
  | 'fail-fast'
  | 'fallback-eligible'
  | 'unknown';

export interface RetryErrorClassificationContext {
  authType?: AuthType | string;
  extraRetryErrorCodes?: readonly number[];
}

export interface RetryErrorClassification {
  kind: RetryErrorKind;
  diagnosis: RetryErrorDiagnosis;
  reason: string;
  statusCode?: number;
  providerCode?: string;
  providerMessage?: string;
  requestId?: string;
  transportCode?: string;
}

/**
 * Classifies retry-related failures.
 *
 * The result is primarily diagnostic — it labels the observed error shape for
 * logging. It also feeds a single control decision in `retryWithBackoff`: a
 * `'fail-fast'` diagnosis keeps a permanent error (e.g. allocated-quota
 * exhaustion surfacing as HTTP 429) out of the unbounded persistent loop.
 * Beyond that, it does not drive retry, fail-fast, or fallback control.
 */
export function classifyRetryError(
  error: unknown,
  context: RetryErrorClassificationContext = {},
): RetryErrorClassification {
  if (isRetryAbortError(error)) {
    return {
      kind: 'abort',
      diagnosis: 'fail-fast',
      reason: 'aborted',
    };
  }

  const details = getRateLimitErrorDetails(error);
  const statusCode = details.statusCode;
  const providerFields = getProviderFields(error);
  const providerCode = details.providerCode ?? providerFields.providerCode;
  const providerMessage =
    details.providerMessage ?? providerFields.providerMessage;
  const requestId = details.requestId ?? providerFields.requestId;
  const common = {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerMessage !== undefined ? { providerMessage } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };

  if (
    context.authType === AuthType.QWEN_OAUTH &&
    isQwenQuotaExceededError(error)
  ) {
    return {
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      reason: 'qwen-oauth-free-tier-quota',
      ...common,
    };
  }

  if (isAllocatedQuotaExceeded(providerCode)) {
    return {
      kind: 'provider-business',
      diagnosis: 'fail-fast',
      reason: 'allocated-quota-exceeded',
      ...common,
    };
  }

  if (isRateLimitError(error, context.extraRetryErrorCodes)) {
    const kind: RetryErrorKind =
      details.transport === 'sse'
        ? 'sse-provider'
        : statusCode !== undefined
          ? 'http'
          : 'provider';
    return {
      kind,
      diagnosis: 'retryable',
      reason: 'rate-limit',
      ...common,
    };
  }

  // Check transport-level codes before the HTTP status block, but only when the
  // status is itself transient (5xx) or absent. An error can carry both an HTTP
  // status and a transport cause (e.g. an SDK error with status 500 whose
  // `cause` is ECONNRESET); the socket-level failure is the more fundamental
  // classification, so it wins, with the HTTP status reported as secondary
  // context. A definitive 4xx status (auth/client error) stays authoritative —
  // a transient socket code must not relabel a permanent failure as retryable.
  const transportCode = getTransportCode(error);
  if (
    transportCode !== undefined &&
    (statusCode === undefined || statusCode >= 500)
  ) {
    return {
      kind: 'transport',
      diagnosis: 'retryable',
      reason: 'transport-error',
      transportCode,
      ...(statusCode !== undefined ? { statusCode } : {}),
    };
  }

  if (statusCode !== undefined) {
    const kind: RetryErrorKind =
      details.transport === 'sse' ? 'sse-provider' : 'http';

    if (statusCode === 529) {
      // Retryable here: this PR retries 529 via isTransientCapacityError and
      // does not implement model/provider fallback. Labeling it
      // "fallback-eligible" would imply behavior that does not exist yet.
      return {
        kind,
        diagnosis: 'retryable',
        reason: 'capacity-overload',
        ...common,
      };
    }

    if (statusCode === 401 || statusCode === 403) {
      return {
        kind,
        diagnosis: 'fail-fast',
        reason: 'auth-error',
        ...common,
      };
    }

    if (statusCode >= 400 && statusCode < 500) {
      return {
        kind,
        diagnosis: 'fail-fast',
        reason: 'client-error',
        ...common,
      };
    }

    if (statusCode >= 500 && statusCode < 600) {
      return {
        kind,
        diagnosis: 'retryable',
        reason: 'server-error',
        ...common,
      };
    }

    return {
      kind,
      diagnosis: 'unknown',
      reason: 'http-status',
      ...common,
    };
  }

  return {
    kind: 'unknown',
    diagnosis: 'unknown',
    reason: 'unclassified',
    ...common,
  };
}

function isRetryAbortError(error: unknown): boolean {
  if (isAbortError(error)) {
    return true;
  }

  return error instanceof Error && error.name === 'CanceledError';
}

function getTransportCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const directCode = (error as { code?: unknown }).code;
  if (typeof directCode === 'string' && isTransportCode(directCode)) {
    return directCode;
  }

  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string' && isTransportCode(causeCode)) {
      return causeCode;
    }
  }

  return undefined;
}

function isTransportCode(code: string): boolean {
  return TRANSPORT_ERROR_CODES.has(code);
}

const TRANSPORT_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function isAllocatedQuotaExceeded(providerCode?: string): boolean {
  return providerCode === 'Throttling.AllocationQuota';
}

interface ProviderFields {
  providerCode?: string;
  providerMessage?: string;
  requestId?: string;
}

function getProviderFields(error: unknown): ProviderFields {
  if (typeof error !== 'object' || error === null) {
    return {};
  }

  const source = error as {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
    requestId?: unknown;
  };
  const rawCode =
    typeof source.code === 'string' || typeof source.code === 'number'
      ? String(source.code)
      : undefined;
  // A numeric `code` in the HTTP status range is just the HTTP status echoed
  // back (e.g. `{ status: 429, code: 429 }`); reporting it as a provider code
  // would be redundant and misleading, so drop it — `statusCode` already
  // carries that information.
  const isHttpStatusEcho =
    typeof source.code === 'number' && source.code >= 100 && source.code < 600;
  const providerCode =
    (error instanceof Error && rawCode?.startsWith('ERR_')) || isHttpStatusEcho
      ? undefined
      : rawCode;
  const requestId =
    typeof source.request_id === 'string'
      ? source.request_id
      : typeof source.requestId === 'string'
        ? source.requestId
        : undefined;
  const providerMessage =
    typeof source.message === 'string' &&
    (!(error instanceof Error) ||
      providerCode !== undefined ||
      requestId !== undefined)
      ? source.message
      : undefined;

  return {
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerMessage !== undefined ? { providerMessage } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}
