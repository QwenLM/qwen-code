// Force strict mode and setup for ESM
"use strict";
import {
  delay
} from "./chunk-NFC4WTY2.js";
import {
  isTlsVerificationDisabled
} from "./chunk-SBP43AO6.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/fetch.ts
init_esbuild_shims();
import { URL } from "node:url";
var PRIVATE_IP_RANGES = [
  /^10\./,
  /^127\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  // IPv4 link-local (incl. cloud metadata endpoints) and CGNAT 100.64.0.0/10.
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^::$/,
  // ULA fc00::/7 covers fc00: through fdff: (fd00: is the common prefix in
  // practice); link-local fe80::/10 covers fe80: through febf:.
  /^f[cd][0-9a-f]{2}:/i,
  /^fe[89ab][0-9a-f]:/i
];
var TLS_ERROR_CODES = /* @__PURE__ */ new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);
var FETCH_TROUBLESHOOTING_ERROR_CODES = /* @__PURE__ */ new Set([
  ...TLS_ERROR_CODES,
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH"
]);
var FetchError = class extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.name = "FetchError";
  }
  static {
    __name(this, "FetchError");
  }
};
var CONNECTION_LEVEL_ERROR_CODES = /* @__PURE__ */ new Set([
  ...TLS_ERROR_CODES,
  "ECONNREFUSED",
  "EPROTO",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  // Servers that don't speak TLS on 443 often reset during the handshake
  // rather than refusing the connection. Safe to include: the http fallback
  // only ever fires for URLs the caller requested as http.
  "ECONNRESET",
  "UND_ERR_SOCKET",
  // Filtered port 443 (silent drop): undici's own bounded connect timeout.
  // Deliberately NOT the full-budget ETIMEDOUT — that can fire mid-body on
  // a healthy https server, and a fallback there would double a worst-case
  // 60s wait for an ambiguous gain.
  "UND_ERR_CONNECT_TIMEOUT"
]);
function isConnectionLevelError(error) {
  return error instanceof FetchError && error.code !== void 0 && CONNECTION_LEVEL_ERROR_CODES.has(error.code);
}
__name(isConnectionLevelError, "isConnectionLevelError");
function mappedIpv4(hostname) {
  const match = /^::ffff:(.+)$/i.exec(hostname);
  if (!match) return void 0;
  const tail = match[1];
  if (tail.includes(".")) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2) return void 0;
  const hi = Number.parseInt(groups[0], 16);
  const lo = Number.parseInt(groups[1], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return void 0;
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}
__name(mappedIpv4, "mappedIpv4");
function isPrivateAddress(address) {
  const bare = address.replace(/^\[|\]$/g, "");
  const target = mappedIpv4(bare) ?? bare;
  return PRIVATE_IP_RANGES.some((range) => range.test(target));
}
__name(isPrivateAddress, "isPrivateAddress");
function isPrivateIp(url) {
  try {
    return isPrivateAddress(new URL(url).hostname);
  } catch (_e) {
    return false;
  }
}
__name(isPrivateIp, "isPrivateIp");
var INTERNAL_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home.arpa"];
function isPrivateHost(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "host.docker.internal" || // Single-label hostnames (intranet, ci, printserver) are never public.
    // IPv6 literals are bracketed and dot-free but CAN be public — they
    // are classified by isPrivateIp below, not by this heuristic.
    !hostname.includes(".") && !hostname.startsWith("[") || INTERNAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) || isPrivateIp(url);
  } catch {
    return false;
  }
}
__name(isPrivateHost, "isPrivateHost");
var REDIRECT_STATUSES = /* @__PURE__ */ new Set([301, 302, 303, 307, 308]);
function isPermittedRedirect(originalUrl, redirectUrl) {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl);
    if (redirect.protocol !== original.protocol) return false;
    if (redirect.port !== original.port) return false;
    if (redirect.username || redirect.password) return false;
    const stripWww = /* @__PURE__ */ __name((hostname) => hostname.replace(/^www\./, ""), "stripWww");
    return stripWww(original.hostname) === stripWww(redirect.hostname);
  } catch {
    return false;
  }
}
__name(isPermittedRedirect, "isPermittedRedirect");
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([403, 429]);
var RETRYABLE_ERROR_CODES = /* @__PURE__ */ new Set([
  "ECONNRESET",
  "EAI_AGAIN",
  "UND_ERR_SOCKET"
]);
var RETRY_DELAY_MS = 500;
async function fetchWithPolicy(url, options) {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
  const abortError = /* @__PURE__ */ __name(() => {
    if (options.signal?.aborted) {
      return options.signal.reason instanceof Error ? options.signal.reason : new FetchError("Request aborted", "ABORT_ERR");
    }
    if (timeoutSignal.aborted) {
      return new FetchError(
        `Request timed out after ${options.timeoutMs}ms`,
        "ETIMEDOUT"
      );
    }
    return void 0;
  }, "abortError");
  let first;
  try {
    first = await fetchPolicyAttempt(url, options, signal, timeoutSignal);
  } catch (error) {
    if (error instanceof FetchError && error.code !== void 0 && RETRYABLE_ERROR_CODES.has(error.code) && !signal.aborted) {
      try {
        await delay(RETRY_DELAY_MS, signal);
      } catch {
        throw abortError() ?? error;
      }
      return fetchPolicyAttempt(url, options, signal, timeoutSignal);
    }
    throw error;
  }
  if (first.kind === "response" && RETRYABLE_STATUSES.has(first.status) && !signal.aborted) {
    try {
      await delay(RETRY_DELAY_MS, signal);
      return await fetchPolicyAttempt(url, options, signal, timeoutSignal);
    } catch {
      const aborted = abortError();
      if (aborted) throw aborted;
      return first;
    }
  }
  return first;
}
__name(fetchWithPolicy, "fetchWithPolicy");
async function fetchPolicyAttempt(url, options, signal, timeoutSignal) {
  const wrapAbort = /* @__PURE__ */ __name((error) => {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new FetchError("Request aborted", "ABORT_ERR");
    }
    if (timeoutSignal.aborted) {
      throw new FetchError(
        `Request timed out after ${options.timeoutMs}ms`,
        "ETIMEDOUT"
      );
    }
    if (error instanceof FetchError) throw error;
    const code = getErrorCode(error) ?? (error instanceof Error ? getErrorCode(error.cause) : void 0);
    throw new FetchError(getErrorMessage(error), code);
  }, "wrapAbort");
  let currentUrl = url;
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    let response;
    try {
      response = await fetch(currentUrl, {
        signal,
        headers: options.headers,
        redirect: "manual"
      });
    } catch (error) {
      return wrapAbort(error);
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {
      });
      if (!location) {
        throw new FetchError("Redirect response missing Location header");
      }
      let redirectUrl;
      try {
        redirectUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new FetchError(
          `Redirect response has a malformed Location header: ${location}`
        );
      }
      if (!isPermittedRedirect(currentUrl, redirectUrl)) {
        return {
          kind: "cross-host-redirect",
          originalUrl: currentUrl,
          redirectUrl,
          status: response.status
        };
      }
      currentUrl = redirectUrl;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {
      });
      return {
        kind: "response",
        status: response.status,
        statusText: response.statusText,
        contentType: response.headers.get("content-type") ?? "",
        contentDisposition: response.headers.get("content-disposition") ?? "",
        body: Buffer.alloc(0),
        finalUrl: currentUrl
      };
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
      await response.body?.cancel().catch(() => {
      });
      throw new FetchError(
        `Response too large: ${contentLength} bytes exceeds the ${options.maxBytes}-byte limit`,
        "EMSGSIZE"
      );
    }
    const chunks = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (; ; ) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > options.maxBytes) {
            throw new FetchError(
              `Response too large: exceeded the ${options.maxBytes}-byte limit while streaming`,
              "EMSGSIZE"
            );
          }
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {
        });
        if (error instanceof FetchError) throw error;
        return wrapAbort(error);
      } finally {
        reader.releaseLock();
      }
    }
    return {
      kind: "response",
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      contentDisposition: response.headers.get("content-disposition") ?? "",
      body: Buffer.concat(chunks, total),
      finalUrl: currentUrl
    };
  }
  throw new FetchError(
    `Too many redirects (exceeded ${options.maxRedirects})`,
    "EMAXREDIRECTS"
  );
}
__name(fetchPolicyAttempt, "fetchPolicyAttempt");
function getErrorCode(error) {
  if (!error || typeof error !== "object") {
    return void 0;
  }
  if ("code" in error && typeof error["code"] === "string") {
    return error["code"];
  }
  return void 0;
}
__name(getErrorCode, "getErrorCode");
function formatUnknownErrorMessage(error) {
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (!error || typeof error !== "object") {
    return void 0;
  }
  const message = error["message"];
  if (typeof message === "string") {
    return message;
  }
  return void 0;
}
__name(formatUnknownErrorMessage, "formatUnknownErrorMessage");
function formatErrorCause(error) {
  if (!(error instanceof Error)) {
    return void 0;
  }
  const cause = error.cause;
  if (!cause) {
    return void 0;
  }
  const causeCode = getErrorCode(cause);
  const causeMessage = formatUnknownErrorMessage(cause);
  if (!causeCode && !causeMessage) {
    return void 0;
  }
  if (causeCode && causeMessage && !causeMessage.includes(causeCode)) {
    return `${causeCode}: ${causeMessage}`;
  }
  return causeMessage ?? causeCode;
}
__name(formatErrorCause, "formatErrorCause");
function formatFetchErrorForUser(error, options = {}) {
  const errorMessage = getErrorMessage(error);
  const code = error instanceof Error ? getErrorCode(error.cause) ?? getErrorCode(error) : getErrorCode(error);
  const cause = formatErrorCause(error);
  const fullErrorMessage = [
    errorMessage,
    cause ? `(cause: ${cause})` : void 0
  ].filter(Boolean).join(" ");
  const shouldShowFetchHints = errorMessage.toLowerCase().includes("fetch failed") || code != null && FETCH_TROUBLESHOOTING_ERROR_CODES.has(code);
  const shouldShowTlsHint = code != null && TLS_ERROR_CODES.has(code);
  if (!shouldShowFetchHints) {
    return fullErrorMessage;
  }
  const hintLines = [
    "",
    "Troubleshooting:",
    ...options.url ? [`- Confirm you can reach ${options.url} from this machine.`] : [],
    "- If you are behind a proxy, pass `--proxy <url>` (or set `proxy` in settings).",
    ...shouldShowTlsHint ? isTlsVerificationDisabled() ? [
      "- TLS verification is already disabled (`--insecure` / `QWEN_TLS_INSECURE`), so this is likely a network or protocol issue rather than a certificate trust problem."
    ] : [
      "- If your network uses a corporate TLS inspection CA, set `NODE_EXTRA_CA_CERTS` to your CA bundle.",
      "- For a trusted self-signed endpoint, pass `--insecure` (or set `QWEN_TLS_INSECURE=1`) to skip certificate verification."
    ] : []
  ];
  return `${fullErrorMessage}${hintLines.join("\n")}`;
}
__name(formatFetchErrorForUser, "formatFetchErrorForUser");

export {
  isConnectionLevelError,
  isPrivateHost,
  isPermittedRedirect,
  fetchWithPolicy,
  formatFetchErrorForUser
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
