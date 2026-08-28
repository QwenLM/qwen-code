/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from './auth-type.js';
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

export type RetryErrorDiagnosis = 'retryable' | 'fail-fast' | 'unknown';

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
      // 529 stays retryable for existing consumers. Model fallback is decided
      // separately by status code after same-model retries are exhausted.
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
      // A 4xx that is actually a wrapped low-level network failure (e.g.
      // "400 network error ... EOF" when the peer closed mid-request) is
      // transient, not a permanent client error. There is no provider error
      // body in that case, and no manual retry (Ctrl+Y) in channel/daemon
      // paths, so classify it retryable so the bounded auto-retry applies.
      // Genuine client 4xx (which carry provider fields) stay fail-fast.
      if (
        providerCode === undefined &&
        providerMessage === undefined &&
        hasNetworkFailureCause(error)
      ) {
        return {
          kind: 'transport',
          diagnosis: 'retryable',
          reason: 'network-error',
          ...common,
        };
      }
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

// SDKs wrap socket-level failures a couple of cause levels deep — e.g. the
// OpenAI SDK surfaces a pre-header reset as APIConnectionError ->
// TypeError('fetch failed') -> cause { code: 'ECONNRESET' }. Walk the cause
// chain so those still reach the transport classification. The bound keeps a
// malformed or circular chain from an unbounded traversal.
const MAX_TRANSPORT_CAUSE_DEPTH = 4;

export function getTransportCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_TRANSPORT_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && isTransportCode(code)) {
      return code;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function isTransportCode(code: string): boolean {
  return TRANSPORT_ERROR_CODES.has(code);
}

// A peer closing the connection mid-request surfaces as a low-level network
// failure (EOF / "network error") that some clients/proxies wrap in a 4xx
// status. Unlike a genuine client error there is no provider error body, so
// detect it by walking the message/cause chain for a transport code or an
// EOF / network-error marker. Used to classify such wrapped failures as
// retryable (there is no manual retry in channel/daemon paths).
const NETWORK_FAILURE_MESSAGE_RE = /\bEOF\b|network error/i;

export function hasNetworkFailureCause(error: unknown): boolean {
  if (getTransportCode(error) !== undefined) return true;
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_TRANSPORT_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) return false;
    const message = (current as { message?: unknown }).message;
    if (
      typeof message === 'string' &&
      NETWORK_FAILURE_MESSAGE_RE.test(message)
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
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

const FALLBACK_ELIGIBLE_STATUS_CODES = new Set([429, 503, 529]);

/**
 * Determines whether a classified error is eligible for model fallback.
 *
 * The PR scope is intentionally narrow: fallback only applies to the explicit
 * capacity statuses documented for the feature (429/503/529), after same-model
 * retries are exhausted.
 */
export function isFallbackEligible(
  classification: RetryErrorClassification,
): boolean {
  return (
    classification.kind !== 'transport' &&
    classification.statusCode !== undefined &&
    FALLBACK_ELIGIBLE_STATUS_CODES.has(classification.statusCode) &&
    classification.diagnosis !== 'fail-fast' &&
    classification.diagnosis !== 'unknown'
  );
}
