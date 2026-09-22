// Force strict mode and setup for ESM
"use strict";
import {
  ResponsesHttpError
} from "./chunk-MS4SXNJ6.js";
import {
  getErrorStatus,
  isAbortError
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/quotaErrorDetection.ts
init_esbuild_shims();
function isApiError(error) {
  return typeof error === "object" && error !== null && "error" in error && typeof error.error === "object" && error.error !== null && "message" in error.error;
}
__name(isApiError, "isApiError");
function isStructuredError(error) {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string";
}
__name(isStructuredError, "isStructuredError");
function isQwenQuotaExceededError(error) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const { status, code, message } = error;
  return status === 429 && code === "insufficient_quota" && typeof message === "string" && message.toLowerCase().includes("free allocated quota exceeded");
}
__name(isQwenQuotaExceededError, "isQwenQuotaExceededError");
var QUOTA_EXHAUSTED_PREFIX = "Quota exhausted: ";
function getQuotaMessage(error) {
  let message = null;
  if (typeof error === "string") message = error;
  else if (isStructuredError(error)) message = error.message;
  else if (isApiError(error)) message = error.error.message;
  if (message === null) return null;
  const start = message.indexOf("{");
  if (start !== -1) {
    try {
      const parsed = JSON.parse(message.substring(start));
      if (isApiError(parsed)) return parsed.error.message;
    } catch {
    }
  }
  return message;
}
__name(getQuotaMessage, "getQuotaMessage");
function isQuotaExhaustedError(error) {
  const message = getQuotaMessage(error);
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("quota") && (lower.includes("exhausted") || lower.includes("exceeded")) && (lower.includes("will reset") || lower.includes("reset at"));
}
__name(isQuotaExhaustedError, "isQuotaExhaustedError");
function formatQuotaExhaustedMessage(error) {
  const raw = getQuotaMessage(error) ?? "";
  if (raw.startsWith(QUOTA_EXHAUSTED_PREFIX)) return raw;
  const stripped = raw.replace(/^\d{3}\s+/, "").trim() || "quota has been exhausted";
  return `${QUOTA_EXHAUSTED_PREFIX}${stripped}

Please retry after the reset time, or switch to another API key / auth method.`;
}
__name(formatQuotaExhaustedMessage, "formatQuotaExhaustedMessage");

// packages/core/src/utils/rateLimit.ts
init_esbuild_shims();

// packages/core/src/utils/retryPolicy.ts
init_esbuild_shims();
var MAX_TIMEOUT_MS = 2147483647;
function getRetryDelayMs(options) {
  const normalizedAttempt = Math.max(1, options.attempt);
  const delayCeilingMs = Math.min(options.maxDelayMs, MAX_TIMEOUT_MS);
  const exponent = Math.min(normalizedAttempt - 1, 31);
  const cappedExponentialDelayMs = Math.min(
    options.initialDelayMs * Math.pow(2, exponent),
    delayCeilingMs
  );
  const retryAfterMode = options.retryAfterMode ?? "ignore";
  const retryAfterMs = retryAfterMode === "ignore" ? null : getRetryAfterDelayMs(options.error);
  if (retryAfterMs !== null && retryAfterMs > 0) {
    const retryAfterCapMs = Math.min(
      options.retryAfterMaxDelayMs ?? options.maxDelayMs,
      MAX_TIMEOUT_MS
    );
    const cappedRetryAfterMs = Math.min(retryAfterMs, retryAfterCapMs);
    return Math.max(cappedExponentialDelayMs, cappedRetryAfterMs);
  }
  const jitterRatio = options.jitterRatio ?? 0;
  if (jitterRatio <= 0) return cappedExponentialDelayMs;
  const random = options.random ?? Math.random;
  const jitter = cappedExponentialDelayMs * jitterRatio * (random() * 2 - 1);
  return Math.min(
    Math.max(0, cappedExponentialDelayMs + jitter),
    delayCeilingMs
  );
}
__name(getRetryDelayMs, "getRetryDelayMs");
function getRetryAfterDelayMs(error) {
  const millis = getHeaderValue(error, "retry-after-ms") ?? getResponseHeaderValue(error, "retry-after-ms");
  if (millis !== null && /^\d+(\.\d+)?$/.test(millis.trim())) {
    const value2 = Number(millis);
    if (Number.isFinite(value2)) return Math.min(value2, MAX_TIMEOUT_MS);
  }
  const value = getHeaderValue(error, "retry-after") ?? getResponseHeaderValue(error, "retry-after");
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1e3, MAX_TIMEOUT_MS);
    }
  }
  const retryAtMs = Date.parse(trimmed);
  if (!Number.isFinite(retryAtMs)) return null;
  const delayMs = retryAtMs - Date.now();
  return delayMs > 0 ? Math.min(delayMs, MAX_TIMEOUT_MS) : 0;
}
__name(getRetryAfterDelayMs, "getRetryAfterDelayMs");
function getHeaderValue(error, headerName) {
  if (!hasHeaders(error)) return null;
  const { headers } = error;
  if (typeof headers.get === "function") {
    const value = headers.get(headerName);
    return typeof value === "string" ? value : null;
  }
  if (typeof headers !== "object" || headers === null) return null;
  const lowerHeaderName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lowerHeaderName) continue;
    return typeof value === "string" ? value : null;
  }
  return null;
}
__name(getHeaderValue, "getHeaderValue");
function getResponseHeaderValue(error, headerName) {
  if (!hasResponseHeaders(error)) return null;
  return getHeaderValue(error.response, headerName);
}
__name(getResponseHeaderValue, "getResponseHeaderValue");
function hasHeaders(error) {
  return typeof error === "object" && error !== null && "headers" in error && error.headers != null;
}
__name(hasHeaders, "hasHeaders");
function hasResponseHeaders(error) {
  return typeof error === "object" && error !== null && "response" in error && typeof error.response === "object" && error.response !== null && "headers" in error.response && error.response.headers != null;
}
__name(hasResponseHeaders, "hasResponseHeaders");

// packages/core/src/utils/rateLimit.ts
var RATE_LIMIT_ERROR_CODES = /* @__PURE__ */ new Set([429, 503, 1302, 1305]);
function isRateLimitError(error, extraCodes) {
  const code = getErrorCode(error);
  if (code === null) return isStatuslessThrottle(error);
  if (RATE_LIMIT_ERROR_CODES.has(code)) return true;
  if (extraCodes && extraCodes.includes(code)) return true;
  return false;
}
__name(isRateLimitError, "isRateLimitError");
function isStatuslessThrottle(error) {
  for (const payload of [error, ...getJsonPayloads(error)]) {
    const selected = providerErrorSource(payload);
    if (!selected) continue;
    const { source } = selected;
    const { type, message } = source;
    if (type === "rate_limit_error" || type === "overloaded_error") return true;
    if (type !== "invalid_request_error" || typeof message !== "string")
      continue;
    const detail = decodeProviderMessage(message)?.["message"] ?? message;
    if (typeof detail === "string" && /^too many requests\b/i.test(detail.trim()) && /\b(?:wait|try(?:ing)? again)\b/i.test(detail)) {
      return true;
    }
  }
  return false;
}
__name(isStatuslessThrottle, "isStatuslessThrottle");
function providerErrorSource(payload) {
  if (typeof payload !== "object" || payload === null) return null;
  const direct = payload;
  const nested = direct["error"];
  const source = typeof nested === "object" && nested !== null ? nested : direct;
  return { source, direct };
}
__name(providerErrorSource, "providerErrorSource");
function decodeProviderMessage(message) {
  try {
    const selected = providerErrorSource(JSON.parse(message));
    if (!selected || typeof selected.source["message"] !== "string") {
      return null;
    }
    return { ...selected.direct, ...selected.source };
  } catch {
    return null;
  }
}
__name(decodeProviderMessage, "decodeProviderMessage");
function getRateLimitErrorDetails(error) {
  const statusCode = getErrorStatus(error);
  const payload = getProviderErrorPayload(error);
  const message = getRawErrorMessage(error);
  const transport = message?.includes("event:error") || message?.includes("HTTP_STATUS/") ? "sse" : statusCode !== void 0 ? "http" : "unknown";
  return {
    ...statusCode !== void 0 ? { statusCode } : {},
    ...payload?.code !== void 0 || payload?.type !== void 0 ? { providerCode: String(payload.code ?? payload.type) } : {},
    ...payload?.type !== void 0 ? { providerType: payload.type } : {},
    ...payload?.message !== void 0 ? { providerMessage: payload.message } : {},
    ...payload?.requestId !== void 0 ? { requestId: payload.requestId } : {},
    transport
  };
}
__name(getRateLimitErrorDetails, "getRateLimitErrorDetails");
function getRateLimitRetryDelayMs(attempt, options) {
  return getRetryDelayMs({
    attempt,
    initialDelayMs: options.initialDelayMs,
    maxDelayMs: options.maxDelayMs,
    retryAfterMode: "minimum",
    retryAfterMaxDelayMs: options.maxDelayMs,
    error: options.error
  });
}
__name(getRateLimitRetryDelayMs, "getRateLimitRetryDelayMs");
function getErrorCode(error) {
  if (isApiError(error)) {
    const n = Number(error.error.code);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  if (msg) {
    const i = msg.indexOf("{");
    if (i !== -1) {
      try {
        const p = JSON.parse(msg.substring(i));
        if (isApiError(p)) {
          const n = Number(p.error.code);
          if (Number.isFinite(n) && n > 0) return n;
        }
      } catch {
      }
    }
  }
  if (isStructuredError(error) && typeof error.status === "number") {
    return error.status;
  }
  if (error instanceof Error && "status" in error) {
    const s = error.status;
    if (typeof s === "number") return s;
  }
  return getErrorStatus(error) ?? null;
}
__name(getErrorCode, "getErrorCode");
function getProviderErrorPayload(error) {
  for (const payload of getJsonPayloads(error)) {
    const selected = providerErrorSource(payload);
    if (!selected) continue;
    const { source, direct } = selected;
    const decoded = typeof source["message"] === "string" ? decodeProviderMessage(source["message"]) : null;
    const code = typeof source["code"] === "string" || typeof source["code"] === "number" ? source["code"] : typeof decoded?.["code"] === "string" || typeof decoded?.["code"] === "number" ? decoded["code"] : void 0;
    const type = typeof source["type"] === "string" ? source["type"] : typeof decoded?.["type"] === "string" ? decoded["type"] : void 0;
    const message = typeof decoded?.["message"] === "string" ? decoded["message"] : typeof source["message"] === "string" ? source["message"] : void 0;
    const requestId = typeof source["request_id"] === "string" ? source["request_id"] : typeof source["requestId"] === "string" ? source["requestId"] : typeof direct["request_id"] === "string" ? direct["request_id"] : typeof direct["requestId"] === "string" ? direct["requestId"] : typeof decoded?.["request_id"] === "string" ? decoded["request_id"] : typeof decoded?.["requestId"] === "string" ? decoded["requestId"] : void 0;
    if (code !== void 0 || type !== void 0 || message !== void 0 || requestId !== void 0) {
      return { code, type, message, requestId };
    }
  }
  if (isApiError(error)) {
    const decoded = decodeProviderMessage(error.error.message);
    return {
      code: error.error.code,
      ...typeof decoded?.["type"] === "string" ? { type: decoded["type"] } : {},
      message: typeof decoded?.["message"] === "string" ? decoded["message"] : error.error.message
    };
  }
  return null;
}
__name(getProviderErrorPayload, "getProviderErrorPayload");
function getJsonPayloads(error) {
  const message = getRawErrorMessage(error);
  if (!message) return [];
  const payloads = [];
  for (const line of message.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
    }
  }
  if (payloads.length > 0) return payloads;
  const jsonStart = message.indexOf("{");
  const jsonEnd = message.lastIndexOf("}");
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      payloads.push(
        JSON.parse(message.slice(jsonStart, jsonEnd + 1))
      );
    } catch {
    }
  }
  return payloads;
}
__name(getJsonPayloads, "getJsonPayloads");
function getRawErrorMessage(error) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return null;
}
__name(getRawErrorMessage, "getRawErrorMessage");

// packages/core/src/utils/retryErrorClassification.ts
init_esbuild_shims();
function classifyRetryError(error, context = {}) {
  if (isRetryAbortError(error)) {
    return {
      kind: "abort",
      diagnosis: "fail-fast",
      reason: "aborted"
    };
  }
  const details = getRateLimitErrorDetails(error);
  const statusCode = details.statusCode;
  const providerFields = getProviderFields(error);
  const providerCode = details.providerCode ?? providerFields.providerCode;
  const providerMessage = details.providerMessage ?? providerFields.providerMessage;
  const requestId = details.requestId || providerFields.requestId;
  const common = {
    ...statusCode !== void 0 ? { statusCode } : {},
    ...providerCode !== void 0 ? { providerCode } : {},
    ...providerMessage !== void 0 ? { providerMessage } : {},
    ...requestId !== void 0 ? { requestId } : {}
  };
  if (context.authType === "qwen-oauth" /* QWEN_OAUTH */ && isQwenQuotaExceededError(error)) {
    return {
      kind: "provider-business",
      diagnosis: "fail-fast",
      reason: "qwen-oauth-free-tier-quota",
      ...common
    };
  }
  if (isAllocatedQuotaExceeded(providerCode)) {
    return {
      kind: "provider-business",
      diagnosis: "fail-fast",
      reason: "allocated-quota-exceeded",
      ...common
    };
  }
  if (error instanceof ResponsesHttpError && (error.headers.has("x-should-retry") || statusCode === 408 || statusCode === 409)) {
    return {
      kind: "http",
      diagnosis: error.shouldRetry(context.extraRetryErrorCodes) ? "retryable" : "fail-fast",
      reason: "responses-http-retry-policy",
      ...common
    };
  }
  if (isRateLimitError(error, context.extraRetryErrorCodes)) {
    const kind = details.transport === "sse" ? "sse-provider" : statusCode !== void 0 ? "http" : "provider";
    return {
      kind,
      diagnosis: "retryable",
      reason: "rate-limit",
      ...common
    };
  }
  const transportCode = getTransportCode(error);
  if (transportCode !== void 0 && (statusCode === void 0 || statusCode >= 500)) {
    return {
      kind: "transport",
      diagnosis: "retryable",
      reason: "transport-error",
      transportCode,
      ...statusCode !== void 0 ? { statusCode } : {}
    };
  }
  if (statusCode !== void 0) {
    const kind = details.transport === "sse" ? "sse-provider" : "http";
    if (statusCode === 529) {
      return {
        kind,
        diagnosis: "retryable",
        reason: "capacity-overload",
        ...common
      };
    }
    if (statusCode === 401 || statusCode === 403) {
      return {
        kind,
        diagnosis: "fail-fast",
        reason: "auth-error",
        ...common
      };
    }
    if (statusCode >= 400 && statusCode < 500) {
      if (providerCode === void 0 && providerMessage === void 0 && hasNetworkFailureCause(error)) {
        return {
          kind: "transport",
          diagnosis: "retryable",
          reason: "network-error",
          ...common
        };
      }
      return {
        kind,
        diagnosis: "fail-fast",
        reason: "client-error",
        ...common
      };
    }
    if (statusCode >= 500 && statusCode < 600) {
      return {
        kind,
        diagnosis: "retryable",
        reason: "server-error",
        ...common
      };
    }
    return {
      kind,
      diagnosis: "unknown",
      reason: "http-status",
      ...common
    };
  }
  const statuslessKind = details.transport === "sse" ? "sse-provider" : "provider";
  if (isPermanentProviderCode(providerCode) || isPermanentProviderCode(providerFields.providerType) || isPermanentProviderCode(details.providerType)) {
    return {
      kind: statuslessKind,
      diagnosis: "fail-fast",
      reason: "permanent-provider-code",
      ...common
    };
  }
  if (requestId !== void 0) {
    return {
      kind: statuslessKind,
      diagnosis: "retryable",
      reason: "upstream-error-without-status",
      ...common
    };
  }
  return {
    kind: "unknown",
    diagnosis: "unknown",
    reason: "unclassified",
    ...common
  };
}
__name(classifyRetryError, "classifyRetryError");
function isRetryAbortError(error) {
  if (isAbortError(error)) {
    return true;
  }
  return error instanceof Error && error.name === "CanceledError";
}
__name(isRetryAbortError, "isRetryAbortError");
var MAX_TRANSPORT_CAUSE_DEPTH = 4;
function getTransportCode(error) {
  let current = error;
  for (let depth = 0; depth <= MAX_TRANSPORT_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) {
      return void 0;
    }
    const code = current.code;
    if (typeof code === "string" && isTransportCode(code)) {
      return code;
    }
    current = current instanceof Error ? current.cause : void 0;
  }
  return void 0;
}
__name(getTransportCode, "getTransportCode");
function isTransportCode(code) {
  return TRANSPORT_ERROR_CODES.has(code);
}
__name(isTransportCode, "isTransportCode");
var NETWORK_FAILURE_MESSAGE_RE = /network error for request /i;
function hasNetworkFailureCause(error) {
  let current = error;
  for (let depth = 0; depth <= MAX_TRANSPORT_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const message = current.message;
    if (typeof message === "string" && NETWORK_FAILURE_MESSAGE_RE.test(message)) {
      return true;
    }
    current = current instanceof Error ? current.cause : void 0;
  }
  return false;
}
__name(hasNetworkFailureCause, "hasNetworkFailureCause");
var TRANSPORT_ERROR_CODES = /* @__PURE__ */ new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
function isAllocatedQuotaExceeded(providerCode) {
  return providerCode === "Throttling.AllocationQuota";
}
__name(isAllocatedQuotaExceeded, "isAllocatedQuotaExceeded");
var PERMANENT_PROVIDER_CODE_PATTERN = /^(?:response[_-]?data[_-]?inspection[_-]?failed|data[_-]?inspection[_-]?failed|content[_-]?filter|invalid[_-]?api[_-]?key|arrearage|insufficient[_-]?quota|model[._-]?access[_-]?denied|invalid[_-]?request[_-]?error|authentication[_-]?error|permission[_-]?error|not[_-]?found[_-]?error|billing[_-]?error|invalid[_-]?parameter(?:[_-]?error)?|context[_-]?length[_-]?exceeded|request[_-]?too[_-]?large)$/i;
function isPermanentProviderCode(providerCode) {
  return providerCode !== void 0 && PERMANENT_PROVIDER_CODE_PATTERN.test(providerCode);
}
__name(isPermanentProviderCode, "isPermanentProviderCode");
function getProviderFields(error) {
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const source = error;
  const rawCode = typeof source.code === "string" || typeof source.code === "number" ? String(source.code) : void 0;
  const isHttpStatusEcho = typeof source.code === "number" && source.code >= 100 && source.code < 600;
  const providerCode = error instanceof Error && rawCode?.startsWith("ERR_") || isHttpStatusEcho ? void 0 : rawCode;
  const requestId = firstNonEmptyString(
    source.request_id,
    source.requestId,
    source.requestID
  );
  const providerMessage = typeof source.message === "string" && (!(error instanceof Error) || providerCode !== void 0 || requestId !== void 0) ? source.message : void 0;
  const providerType = firstNonEmptyString(source.type);
  return {
    ...providerCode !== void 0 ? { providerCode } : {},
    ...providerType !== void 0 ? { providerType } : {},
    ...providerMessage !== void 0 ? { providerMessage } : {},
    ...requestId !== void 0 ? { requestId } : {}
  };
}
__name(getProviderFields, "getProviderFields");
var FALLBACK_ELIGIBLE_STATUS_CODES = /* @__PURE__ */ new Set([429, 503, 529]);
function isFallbackEligible(classification) {
  return classification.kind !== "transport" && classification.statusCode !== void 0 && FALLBACK_ELIGIBLE_STATUS_CODES.has(classification.statusCode) && classification.diagnosis !== "fail-fast" && classification.diagnosis !== "unknown";
}
__name(isFallbackEligible, "isFallbackEligible");
function isRetryableUpstreamError(error, extraRetryErrorCodes) {
  return isRateLimitError(error, extraRetryErrorCodes) || classifyRetryError(error, { extraRetryErrorCodes }).diagnosis === "retryable";
}
__name(isRetryableUpstreamError, "isRetryableUpstreamError");
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return void 0;
}
__name(firstNonEmptyString, "firstNonEmptyString");

export {
  isApiError,
  isStructuredError,
  isQwenQuotaExceededError,
  QUOTA_EXHAUSTED_PREFIX,
  isQuotaExhaustedError,
  formatQuotaExhaustedMessage,
  getRetryDelayMs,
  getRetryAfterDelayMs,
  isRateLimitError,
  getRateLimitErrorDetails,
  getRateLimitRetryDelayMs,
  classifyRetryError,
  getTransportCode,
  isFallbackEligible,
  isRetryableUpstreamError
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
