/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from './auth-type.js';
import { isAbortError } from './errors.js';
import { isQwenQuotaExceededError } from './quotaErrorDetection.js';
import { getRateLimitErrorDetails, isRateLimitError } from './rateLimit.js';
import { ResponsesHttpError } from './responses-http-error.js';

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
 * logging. It also drives control: `isRetryableUpstreamError` below turns a
 * `'retryable'` diagnosis into the retry verdict for every error an HTTP status
 * cannot decide, and both retry gates end there; a `'fail-fast'` diagnosis keeps
 * a permanent error (e.g. allocated-quota exhaustion surfacing as HTTP 429) out
 * of the unbounded persistent loop; and `isFallbackEligible` reads the status
 * recorded here to decide model fallback.
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
  // `||`, not `??`: an empty string is not an identifier. The SDK stamps
  // `requestID` from `headers.get('x-request-id')`, which yields '' for a
  // header that is present but empty, and a request id now decides a retry
  // verdict below — so '' must fall through the same way undefined does.
  const requestId = details.requestId || providerFields.requestId;
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

  if (
    error instanceof ResponsesHttpError &&
    (error.headers.has('x-should-retry') ||
      statusCode === 408 ||
      statusCode === 409)
  ) {
    return {
      kind: 'http',
      diagnosis: error.shouldRetry(context.extraRetryErrorCodes)
        ? 'retryable'
        : 'fail-fast',
      reason: 'responses-http-retry-policy',
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
  // The one exception is a provider-body-less 4xx carrying the network-failure
  // message marker, relabeled in the 4xx block below.
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
      // `transportCode` is deliberately left unset: populating it would admit
      // these 4xx-wrapped failures into the transportCode-keyed stream
      // replay/continuation gates.
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

  // Mirrors the transport-mapping branches above, which label by
  // `details.transport`. That field records whether raw SSE framing survived
  // into `.message`, not whether the error came out of a stream: the SDK strips
  // the framing from a mid-stream APIError, so the canonical gateway error
  // frame is labelled 'provider' and only a body pasted into the message reads
  // 'sse-provider'.
  const statuslessKind: RetryErrorKind =
    details.transport === 'sse' ? 'sse-provider' : 'provider';

  // With no status left to read, permanence has to come off the provider body:
  // a moderation rejection necessarily arrives after the 200, and a gateway can
  // relay a credential, billing or malformed-request rejection the same way.
  // Nothing above can fail fast on them, and re-sending the identical request
  // can never succeed.
  //
  // `.type` is read from both sources `code` is read from, because a body can
  // carry a specific `code` beside a class-naming `type` and either may be the
  // permanent one. On the object route `getProviderFields` reads the instance
  // property — that is where the SDK puts `invalid_request_error`, with `code`
  // null. On the message-scraped route the two arrive separately too:
  // `details.providerCode` is the collapsed `code ?? type`, so a sibling `code`
  // hides the `type` unless `details.providerType` is consulted as well.
  if (
    isPermanentProviderCode(providerCode) ||
    isPermanentProviderCode(providerFields.providerType) ||
    isPermanentProviderCode(details.providerType)
  ) {
    return {
      kind: statuslessKind,
      diagnosis: 'fail-fast',
      reason: 'permanent-provider-code',
      ...common,
    };
  }

  // An upstream error body that carries the provider's own request id but no
  // HTTP status. The OpenAI SDK builds exactly this shape when a gateway pushes
  // `{"error": {...}}` into an already-200 SSE stream —
  // `new APIError(undefined, data.error, undefined, response.headers)` — so the
  // status never reaches us, and a server-side failure (observed in the wild as
  // `code: 'KeyError'`, `message: "'id'"`) would otherwise fall through to
  // 'unknown' and kill the turn on the first attempt while a socket cut above
  // is retried. The id can equally arrive inside a provider JSON body embedded
  // in the message.
  //
  // Only a request id opens this gate, and only for a code the list above does
  // not already know as permanent. Local failures carry a string `code` but no
  // request id (`MISSING_API_KEY`, `invalid_config`, MCP's numeric JSON-RPC
  // codes), so they stay unclassified and are not retried. An unrecognised
  // upstream code stays retryable on purpose: the next gateway bug should not
  // have to be taught to this file before it stops killing turns.
  if (requestId !== undefined) {
    return {
      kind: statuslessKind,
      diagnosis: 'retryable',
      reason: 'upstream-error-without-status',
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
// failure that some clients/proxies wrap in a 4xx status. Unlike a genuine
// client error there is no provider error body, so detect the demonstrated
// wrapper shape by its message marker, walking the cause chain (SDKs nest
// the failing request a level or two down). Transport codes are deliberately
// not admitted here: a 4xx carrying a socket code stays fail-fast, as the
// transport block above pins.
const NETWORK_FAILURE_MESSAGE_RE = /network error for request /i;

export function hasNetworkFailureCause(error: unknown): boolean {
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

// Provider codes meaning "re-sending this exact request can never succeed":
// content moderation, credentials/billing, a malformed request, and a payload
// refused for its size. Moderation necessarily happens after the provider has
// already sent 200, so there is no HTTP status to fail fast on, and a gateway
// can relay the others the same way. The oversized-payload codes belong here
// for the same reason: their recovery is compaction, and re-sending the
// identical payload cannot reach it.
//
// Separators are optional and case is ignored because one rejection reaches
// this classifier in several spellings (`data_inspection_failed`,
// `DataInspectionFailed`, `ResponseDataInspectionFailed`). The anchors are
// deliberate: under-matching costs a wasted retry ladder, over-matching costs a
// transient failure that is never retried — the bug this branch exists to fix —
// so open-ended sub-code qualifiers such as `InvalidParameter.Range` are left
// out on purpose.
//
// The credential, entitlement, missing-model and billing spellings are `type`
// values the Anthropic SDK maps to 401/403/404 (400 for billing), every one of
// which the HTTP-status branch above already fails fast on. A gateway relaying
// one into an already-200 stream loses the status, and this list is what keeps
// the verdict the same instead of spending the ladder on it. The union's
// transient members stay out on purpose: `api_error`, `timeout_error` and
// OpenAI's `server_error` remain retryable through the request-id branch
// below, while `rate_limit_error` and `overloaded_error` are caught earlier by
// the rate-limit arm and its Retry-After-aware delay.
const PERMANENT_PROVIDER_CODE_PATTERN =
  /^(?:response[_-]?data[_-]?inspection[_-]?failed|data[_-]?inspection[_-]?failed|content[_-]?filter|invalid[_-]?api[_-]?key|arrearage|insufficient[_-]?quota|model[._-]?access[_-]?denied|invalid[_-]?request[_-]?error|authentication[_-]?error|permission[_-]?error|not[_-]?found[_-]?error|billing[_-]?error|invalid[_-]?parameter(?:[_-]?error)?|context[_-]?length[_-]?exceeded|request[_-]?too[_-]?large)$/i;

function isPermanentProviderCode(providerCode?: string): boolean {
  return (
    providerCode !== undefined &&
    PERMANENT_PROVIDER_CODE_PATTERN.test(providerCode)
  );
}

interface ProviderFields {
  providerCode?: string;
  providerType?: string;
  providerMessage?: string;
  requestId?: string;
}

function getProviderFields(error: unknown): ProviderFields {
  if (typeof error !== 'object' || error === null) {
    return {};
  }

  const source = error as {
    code?: unknown;
    type?: unknown;
    message?: unknown;
    request_id?: unknown;
    requestId?: unknown;
    requestID?: unknown;
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
  // `requestID` is the OpenAI SDK's spelling — it stamps the response's
  // `x-request-id` header onto every APIError, including the status-less ones
  // built from a mid-stream error event. That header can be present and empty,
  // and this value now decides a retry verdict, so '' counts as absent.
  const requestId = firstNonEmptyString(
    source.request_id,
    source.requestId,
    source.requestID,
  );
  const providerMessage =
    typeof source.message === 'string' &&
    (!(error instanceof Error) ||
      providerCode !== undefined ||
      requestId !== undefined)
      ? source.message
      : undefined;
  // `.type` is where the OpenAI SDK puts `invalid_request_error` — for that
  // body it sets `code` to null — so permanence cannot be read off `code`
  // alone. Kept out of the classification struct: it feeds the permanence
  // guard only, and `providerCode` is compared by exact equality elsewhere.
  const providerType = firstNonEmptyString(source.type);

  return {
    ...(providerCode !== undefined ? { providerCode } : {}),
    ...(providerType !== undefined ? { providerType } : {}),
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

/**
 * The retry verdict for everything a caller does not already short-circuit on
 * an HTTP status of its own: HTTP 429/503 and provider rate-limit codes,
 * transport failures, 5xx and 529, and status-less upstream bodies the provider
 * traced with a request id.
 *
 * The rate-limit term is not the redundancy it looks like, but neither is it
 * what keeps throttling retryable: `classifyRetryError` runs the same
 * `isRateLimitError` with the same `extraRetryErrorCodes`, so a throttle this
 * term matches already classifies `'retryable'` without it — deleting the term
 * left the retry, classification and send-loop suites green apart from the one
 * case below. Its only measurable effect is on an error a branch above the
 * rate-limit one already owns: DashScope's allocated-quota exhaustion, which
 * surfaces as HTTP 429 and classifies `fail-fast`. There the term keeps this
 * verdict retryable, so `retryWithBackoff`'s persistent loop bounds the attempt
 * count with its own fail-fast check (3 attempts) rather than stopping at the
 * first. LlmChat's inline predicate short-circuits on its own `status === 429`
 * line, so none of this applies on that path.
 *
 * Both gates end here so the status-less policy is written once. Kept in this
 * module rather than in `retry.ts` because the package barrel re-exports that
 * file, and this policy is not public API.
 */
export function isRetryableUpstreamError(
  error: unknown,
  extraRetryErrorCodes?: readonly number[],
): boolean {
  return (
    isRateLimitError(error, extraRetryErrorCodes) ||
    classifyRetryError(error, { extraRetryErrorCodes }).diagnosis ===
      'retryable'
  );
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value) {
      return value;
    }
  }
  return undefined;
}
