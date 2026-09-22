// Force strict mode and setup for ESM
"use strict";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/runtimeFetchOptions.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("RUNTIME_FETCH");
var undiciModule;
var undiciModulePromise;
async function loadUndici() {
  undiciModulePromise ??= import("./undici-S7WJSKGJ.js").then((mod) => {
    const keys = Object.keys(mod);
    if (keys.length === 1 && keys[0] === "default") {
      return mod.default;
    }
    return mod;
  });
  return undiciModulePromise;
}
__name(loadUndici, "loadUndici");
async function preloadRuntimeFetchModule() {
  if (undiciModule) return;
  undiciModule = await loadUndici();
}
__name(preloadRuntimeFetchModule, "preloadRuntimeFetchModule");
function requireUndici() {
  if (!undiciModule) {
    throw new Error(
      "undici is not loaded yet; await preloadRuntimeFetchModule() before building runtime fetch options or dispatchers"
    );
  }
  return undiciModule;
}
__name(requireUndici, "requireUndici");
function isTlsVerificationDisabled() {
  const flag = process.env["QWEN_TLS_INSECURE"];
  if (flag !== void 0 && /^(1|true|yes|on)$/i.test(flag.trim())) {
    return true;
  }
  return process.env["NODE_TLS_REJECT_UNAUTHORIZED"] === "0";
}
__name(isTlsVerificationDisabled, "isTlsVerificationDisabled");
function detectRuntime() {
  if (typeof process !== "undefined" && process.versions?.["bun"]) {
    return "bun";
  }
  if (typeof process !== "undefined" && process.versions?.node) {
    return "node";
  }
  return "unknown";
}
__name(detectRuntime, "detectRuntime");
function buildRuntimeFetchOptions(sdkType, proxyUrl) {
  const runtime = detectRuntime();
  switch (runtime) {
    case "bun": {
      if (sdkType === "openai") {
        return {
          fetchOptions: {
            timeout: false
          }
        };
      } else {
        const bunFetch = /* @__PURE__ */ __name(async (input, init) => {
          const bunFetchOptions = {
            ...init,
            // @ts-expect-error - Bun-specific timeout option
            timeout: false
          };
          return fetch(input, bunFetchOptions);
        }, "bunFetch");
        return {
          fetch: bunFetch
        };
      }
    }
    case "node": {
      return buildFetchOptionsWithDispatcher(sdkType, proxyUrl);
    }
    default: {
      return buildFetchOptionsWithDispatcher(sdkType, proxyUrl);
    }
  }
}
__name(buildRuntimeFetchOptions, "buildRuntimeFetchOptions");
var dispatcherCache = /* @__PURE__ */ new Map();
var proxyFailureCounts = /* @__PURE__ */ new Map();
var NO_DISPATCHER_FALLBACK = {
  openai: void 0,
  anthropic: {}
};
function getOrCreateSharedDispatcher(proxyUrl, insecure = isTlsVerificationDisabled()) {
  const cacheKey = insecure ? `${proxyUrl}#insecure` : proxyUrl;
  const cached = dispatcherCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const { EnvHttpProxyAgent } = requireUndici();
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: proxyUrl,
    httpsProxy: proxyUrl,
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 6e4,
    // EnvHttpProxyAgent can dispatch either directly or through a proxy.
    // `connect` covers a direct NO_PROXY connection, `requestTls` covers the
    // origin through a proxy, and `proxyTls` covers an HTTPS proxy itself.
    ...insecure ? {
      connect: { rejectUnauthorized: false },
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false }
    } : {}
  });
  dispatcherCache.set(cacheKey, dispatcher);
  return dispatcher;
}
__name(getOrCreateSharedDispatcher, "getOrCreateSharedDispatcher");
var resolvedProxyUrlForRuntimeFetch;
function setResolvedProxyUrlForRuntimeFetch(proxyUrl) {
  resolvedProxyUrlForRuntimeFetch = proxyUrl || void 0;
}
__name(setResolvedProxyUrlForRuntimeFetch, "setResolvedProxyUrlForRuntimeFetch");
function getOrCreateMcpDispatcher(insecure = isTlsVerificationDisabled()) {
  if (resolvedProxyUrlForRuntimeFetch) {
    return getOrCreateSharedDispatcher(
      resolvedProxyUrlForRuntimeFetch,
      insecure
    );
  }
  const cacheKey = insecure ? "__env_proxy__#insecure" : "__env_proxy__";
  const cached = dispatcherCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const { EnvHttpProxyAgent } = requireUndici();
  const dispatcher = new EnvHttpProxyAgent({
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 6e4,
    ...insecure ? {
      connect: { rejectUnauthorized: false },
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false }
    } : {}
  });
  dispatcherCache.set(cacheKey, dispatcher);
  return dispatcher;
}
__name(getOrCreateMcpDispatcher, "getOrCreateMcpDispatcher");
function extractHostnameFromProxyUrl(proxyUrl) {
  try {
    const url = new URL(proxyUrl);
    if (url.hostname) {
      return url.port ? `${url.hostname}:${url.port}` : url.hostname;
    }
  } catch {
  }
  const match = proxyUrl.match(/@([^:/\s]+)(:\d+)?/);
  return match ? match[1] + (match[2] ?? "") : redactProxyCredentials(proxyUrl);
}
__name(extractHostnameFromProxyUrl, "extractHostnameFromProxyUrl");
function hasPlausibleProxyPort(host) {
  const portMatch = host.match(/:(\d{1,5})$/);
  if (!portMatch) {
    return false;
  }
  const port = Number(portMatch[1]);
  return port >= 80 && port <= 65535;
}
__name(hasPlausibleProxyPort, "hasPlausibleProxyPort");
function hasLocalOrProxyLikeHost(host) {
  const hostWithoutPort = host.replace(/:\d{1,5}$/, "").toLowerCase();
  if (hostWithoutPort === "localhost") {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostWithoutPort)) {
    return true;
  }
  return hostWithoutPort.split(/[.-]/).some((label) => /^(proxy|gateway|gw|squid)\d*$/.test(label));
}
__name(hasLocalOrProxyLikeHost, "hasLocalOrProxyLikeHost");
function hasNetworkErrorContext(message, offset) {
  const context = message.slice(Math.max(0, offset - 80), offset).toLowerCase();
  return /\b(connect|dispatcher|econnrefused|econnreset|enotfound|etimedout|proxy|tunnel)\b/.test(
    context
  );
}
__name(hasNetworkErrorContext, "hasNetworkErrorContext");
function shouldRedactTokenOnlyCredential(host, message, offset) {
  return hasPlausibleProxyPort(host) && (hasLocalOrProxyLikeHost(host) || hasNetworkErrorContext(message, offset));
}
__name(shouldRedactTokenOnlyCredential, "shouldRedactTokenOnlyCredential");
function redactProxyCredentials(message) {
  let result = message.replace(/\/\/[^/\s]*@/g, "//<redacted>@");
  result = result.replace(
    /(^|[\s([=:])([^\s/@()[\]=]+@[^@\s/()[\]=]+)/g,
    (match, prefix, candidate, offset, message2) => {
      const atIndex = candidate.indexOf("@");
      const userInfo = candidate.slice(0, atIndex);
      const host = candidate.slice(atIndex + 1);
      if (!userInfo.includes(":") && !shouldRedactTokenOnlyCredential(host, message2, offset)) {
        return match;
      }
      return `${prefix}<redacted>@${host}`;
    }
  );
  return result;
}
__name(redactProxyCredentials, "redactProxyCredentials");
function redactProxyError(error) {
  return redactProxyErrorValue(error, /* @__PURE__ */ new WeakMap());
}
__name(redactProxyError, "redactProxyError");
function redactProxyErrorValue(error, seen) {
  if (typeof error === "string") {
    return redactProxyCredentials(error);
  }
  if (!error || typeof error !== "object") {
    return error;
  }
  if (seen.has(error)) {
    return seen.get(error);
  }
  const errorRecord = error;
  const needsClone = shouldCloneForRedaction(error, errorRecord);
  const redactedMessage = typeof errorRecord.message === "string" ? redactProxyCredentials(errorRecord.message) : void 0;
  const redactedStack = typeof errorRecord.stack === "string" ? redactProxyCredentials(errorRecord.stack) : void 0;
  let redactedCause = errorRecord.cause;
  let redactedErrors = errorRecord.errors;
  if (needsClone) {
    const clone = Object.create(Object.getPrototypeOf(error));
    seen.set(error, clone);
    if (errorRecord.cause !== void 0) {
      redactedCause = redactProxyErrorValue(errorRecord.cause, seen);
    }
    if (errorRecord.errors !== void 0) {
      redactedErrors = redactProxyErrorCollection(errorRecord.errors, seen);
    }
    cloneErrorWithRedactedFields(
      error,
      clone,
      redactedMessage,
      redactedStack,
      redactedCause,
      redactedErrors
    );
    return clone;
  }
  seen.set(error, error);
  try {
    if (redactedMessage !== void 0) {
      errorRecord.message = redactedMessage;
    }
    if (redactedStack !== void 0) {
      errorRecord.stack = redactedStack;
    }
    if (errorRecord.cause !== void 0) {
      redactedCause = redactProxyErrorValue(errorRecord.cause, seen);
      errorRecord.cause = redactedCause;
    }
    if (errorRecord.errors !== void 0) {
      redactedErrors = redactProxyErrorCollection(errorRecord.errors, seen);
      errorRecord.errors = redactedErrors;
    }
    return error;
  } catch {
    const clone = Object.create(Object.getPrototypeOf(error));
    seen.set(error, clone);
    if (errorRecord.cause !== void 0) {
      redactedCause = redactProxyErrorValue(errorRecord.cause, seen);
    }
    if (errorRecord.errors !== void 0) {
      redactedErrors = redactProxyErrorCollection(errorRecord.errors, seen);
    }
    cloneErrorWithRedactedFields(
      error,
      clone,
      redactedMessage,
      redactedStack,
      redactedCause,
      redactedErrors
    );
    return clone;
  }
}
__name(redactProxyErrorValue, "redactProxyErrorValue");
function redactProxyErrorCollection(errors, seen) {
  if (!Array.isArray(errors)) {
    return redactProxyErrorValue(errors, seen);
  }
  if (seen.has(errors)) {
    return seen.get(errors);
  }
  const redactedErrors = [];
  seen.set(errors, redactedErrors);
  for (const error of errors) {
    redactedErrors.push(redactProxyErrorValue(error, seen));
  }
  return redactedErrors;
}
__name(redactProxyErrorCollection, "redactProxyErrorCollection");
function shouldCloneForRedaction(error, errorRecord) {
  return typeof errorRecord.message === "string" && !canAssignProperty(error, "message") || typeof errorRecord.stack === "string" && !canAssignProperty(error, "stack") || errorRecord.cause !== void 0 && !canAssignProperty(error, "cause") || errorRecord.errors !== void 0 && !canAssignProperty(error, "errors");
}
__name(shouldCloneForRedaction, "shouldCloneForRedaction");
function canAssignProperty(target, key) {
  let current = target;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) {
      if ("writable" in descriptor) {
        return descriptor.writable === true;
      }
      return typeof descriptor.set === "function";
    }
    current = Object.getPrototypeOf(current);
  }
  return Object.isExtensible(target);
}
__name(canAssignProperty, "canAssignProperty");
function cloneErrorWithRedactedFields(error, clone, redactedMessage, redactedStack, redactedCause, redactedErrors) {
  const copiedKeys = /* @__PURE__ */ new Set();
  for (const key of Reflect.ownKeys(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor) {
      continue;
    }
    copiedKeys.add(key);
    const updatedDescriptor = getRedactedPropertyDescriptor(
      key,
      descriptor,
      redactedMessage,
      redactedStack,
      redactedCause,
      redactedErrors
    );
    try {
      Object.defineProperty(clone, key, updatedDescriptor);
    } catch {
    }
  }
  defineMissingRedactedValue(clone, copiedKeys, "message", redactedMessage);
  defineMissingRedactedValue(clone, copiedKeys, "stack", redactedStack);
  defineMissingRedactedValue(clone, copiedKeys, "cause", redactedCause);
  defineMissingRedactedValue(clone, copiedKeys, "errors", redactedErrors);
}
__name(cloneErrorWithRedactedFields, "cloneErrorWithRedactedFields");
function getRedactedPropertyDescriptor(key, descriptor, redactedMessage, redactedStack, redactedCause, redactedErrors) {
  const redactedValue = key === "message" ? redactedMessage : key === "stack" ? redactedStack : key === "cause" ? redactedCause : key === "errors" ? redactedErrors : void 0;
  if (redactedValue === void 0) {
    return { ...descriptor };
  }
  if ("value" in descriptor) {
    return { ...descriptor, value: redactedValue };
  }
  return {
    configurable: descriptor.configurable,
    enumerable: descriptor.enumerable,
    value: redactedValue,
    writable: true
  };
}
__name(getRedactedPropertyDescriptor, "getRedactedPropertyDescriptor");
function defineMissingRedactedValue(target, copiedKeys, key, value) {
  if (value === void 0 || copiedKeys.has(key)) {
    return;
  }
  try {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: false,
      value,
      writable: true
    });
  } catch {
  }
}
__name(defineMissingRedactedValue, "defineMissingRedactedValue");
function recordProxyFailure(hostname) {
  const failureCount = (proxyFailureCounts.get(hostname) ?? 0) + 1;
  proxyFailureCounts.set(hostname, failureCount);
  return failureCount;
}
__name(recordProxyFailure, "recordProxyFailure");
function buildFetchOptionsWithDispatcher(sdkType, proxyUrl) {
  const insecure = isTlsVerificationDisabled();
  const { Agent, fetch: undiciFetch } = requireUndici();
  if (!proxyUrl) {
    const NO_PROXY_KEY = insecure ? "__no_proxy__#insecure" : "__no_proxy__";
    let dispatcher = dispatcherCache.get(NO_PROXY_KEY);
    if (!dispatcher) {
      dispatcher = new Agent({
        headersTimeout: 0,
        bodyTimeout: 0,
        keepAliveTimeout: 6e4,
        // For a direct (non-proxy) Agent, `connect` options flow straight to
        // the TLS connector, so this disables upstream cert verification.
        ...insecure ? { connect: { rejectUnauthorized: false } } : {}
      });
      dispatcherCache.set(NO_PROXY_KEY, dispatcher);
    }
    return { fetchOptions: { dispatcher }, fetch: undiciFetch };
  }
  try {
    const dispatcher = getOrCreateSharedDispatcher(proxyUrl, insecure);
    return { fetchOptions: { dispatcher }, fetch: undiciFetch };
  } catch (error) {
    const hostname = extractHostnameFromProxyUrl(proxyUrl);
    const failureCount = recordProxyFailure(hostname);
    const failureLabel = failureCount === 1 ? "first failure" : `failure #${failureCount}`;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const redactedMessage = redactProxyCredentials(errorMessage);
    const logMessage = `Failed to create proxy dispatcher for ${hostname} (${failureLabel}), falling back to direct connection: ${redactedMessage}`;
    debugLogger.warn(logMessage);
    console.error(`[RUNTIME_FETCH] ${logMessage}`);
    return NO_DISPATCHER_FALLBACK[sdkType];
  }
}
__name(buildFetchOptionsWithDispatcher, "buildFetchOptionsWithDispatcher");

// packages/core/src/utils/auth-type.ts
init_esbuild_shims();
var AuthType = /* @__PURE__ */ ((AuthType2) => {
  AuthType2["USE_OPENAI"] = "openai";
  AuthType2["USE_OPENAI_RESPONSES"] = "openai-responses";
  AuthType2["QWEN_OAUTH"] = "qwen-oauth";
  AuthType2["USE_GEMINI"] = "gemini";
  AuthType2["USE_VERTEX_AI"] = "vertex-ai";
  AuthType2["USE_ANTHROPIC"] = "anthropic";
  return AuthType2;
})(AuthType || {});

export {
  loadUndici,
  preloadRuntimeFetchModule,
  isTlsVerificationDisabled,
  detectRuntime,
  buildRuntimeFetchOptions,
  getOrCreateSharedDispatcher,
  setResolvedProxyUrlForRuntimeFetch,
  getOrCreateMcpDispatcher,
  redactProxyCredentials,
  redactProxyError,
  AuthType
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
