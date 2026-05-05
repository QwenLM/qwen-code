/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { getErrorStatus, isAbortError } from './errors.js';
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

export type RetryErrorDecision =
  | 'retryable'
  | 'fail-fast'
  | 'fallback-eligible'
  | 'unknown';

export interface RetryErrorClassificationContext {
  authType?: AuthType | string;
}

export interface RetryErrorClassification {
  kind: RetryErrorKind;
  decision: RetryErrorDecision;
  reason: string;
  statusCode?: number;
  providerCode?: string;
  providerMessage?: string;
  requestId?: string;
  transportCode?: string;
}

/**
 * Classifies retry-related failures without performing the retry decision.
 *
 * The result is intentionally conservative: it provides stable diagnostics and
 * policy inputs while leaving fallback/recovery execution to later layers.
 */
export function classifyRetryError(
  error: unknown,
  context: RetryErrorClassificationContext = {},
): RetryErrorClassification {
  if (isAbortError(error)) {
    return {
      kind: 'abort',
      decision: 'fail-fast',
      reason: 'aborted',
    };
  }

  const details = getRateLimitErrorDetails(error);
  const statusCode = getErrorStatus(error);
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
      decision: 'fail-fast',
      reason: 'qwen-oauth-free-tier-quota',
      ...common,
    };
  }

  if (isAllocatedQuotaExceeded(providerCode, providerMessage)) {
    return {
      kind: 'provider-business',
      decision: 'fail-fast',
      reason: 'allocated-quota-exceeded',
      ...common,
    };
  }

  if (isRateLimitError(error)) {
    const kind: RetryErrorKind =
      details.transport === 'sse'
        ? 'sse-provider'
        : statusCode !== undefined
          ? 'http'
          : 'provider';
    return {
      kind,
      decision: 'retryable',
      reason: 'rate-limit',
      ...common,
    };
  }

  if (statusCode !== undefined) {
    const kind: RetryErrorKind =
      details.transport === 'sse' ? 'sse-provider' : 'http';

    if (statusCode === 529) {
      return {
        kind,
        decision: 'fallback-eligible',
        reason: 'capacity-overload',
        ...common,
      };
    }

    if (statusCode === 401 || statusCode === 403) {
      return {
        kind,
        decision: 'fail-fast',
        reason: 'auth-error',
        ...common,
      };
    }

    if (statusCode >= 400 && statusCode < 500) {
      return {
        kind,
        decision: 'fail-fast',
        reason: 'client-error',
        ...common,
      };
    }

    if (statusCode >= 500 && statusCode < 600) {
      return {
        kind,
        decision: 'retryable',
        reason: 'server-error',
        ...common,
      };
    }

    return {
      kind,
      decision: 'unknown',
      reason: 'http-status',
      ...common,
    };
  }

  const transportCode = getTransportCode(error);
  if (transportCode !== undefined) {
    return {
      kind: 'transport',
      decision: 'retryable',
      reason: 'transport-error',
      transportCode,
    };
  }

  return {
    kind: 'unknown',
    decision: 'unknown',
    reason: 'unclassified',
    ...common,
  };
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

function isAllocatedQuotaExceeded(
  providerCode?: string,
  providerMessage?: string,
): boolean {
  if (providerCode === 'Throttling.AllocationQuota') {
    return true;
  }

  return (
    providerMessage?.toLowerCase().includes('allocated quota exceeded') ?? false
  );
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

  return {
    ...(typeof source.code === 'string' || typeof source.code === 'number'
      ? { providerCode: String(source.code) }
      : {}),
    ...(typeof source.message === 'string'
      ? { providerMessage: source.message }
      : {}),
    ...(typeof source.request_id === 'string'
      ? { requestId: source.request_id }
      : typeof source.requestId === 'string'
        ? { requestId: source.requestId }
        : {}),
  };
}
