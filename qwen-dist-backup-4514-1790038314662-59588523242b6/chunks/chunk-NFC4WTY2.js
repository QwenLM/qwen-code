// Force strict mode and setup for ESM
"use strict";
import {
  classifyRetryError,
  formatQuotaExhaustedMessage,
  getRetryAfterDelayMs,
  getRetryDelayMs,
  isQuotaExhaustedError,
  isQwenQuotaExceededError,
  isRetryableUpstreamError
} from "./chunk-YSD6IY6F.js";
import {
  ResponsesHttpError
} from "./chunk-MS4SXNJ6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorStatus
} from "./chunk-S34QJ6IR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/retryContext.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var retryContext = new AsyncLocalStorage();

// packages/core/src/utils/retry.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("RETRY");
var PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1e3;
var PERSISTENT_CAP_MS = 6 * 60 * 60 * 1e3;
var HEARTBEAT_INTERVAL_MS = 3e4;
var DEFAULT_RETRY_OPTIONS = {
  maxAttempts: 7,
  initialDelayMs: 1500,
  maxDelayMs: 3e4,
  // 30 seconds
  shouldRetryOnError: defaultShouldRetry
};
function defaultShouldRetry(error, extraRetryErrorCodes) {
  if (error instanceof ResponsesHttpError) {
    return error.shouldRetry(extraRetryErrorCodes);
  }
  const status = getErrorStatus(error);
  if (status !== void 0 && status >= 500 && status < 600) {
    return true;
  }
  return isRetryableUpstreamError(error, extraRetryErrorCodes);
}
__name(defaultShouldRetry, "defaultShouldRetry");
function hasRetryAfterStatus(status) {
  return status === 429 || status === 503;
}
__name(hasRetryAfterStatus, "hasRetryAfterStatus");
function isTransientCapacityError(error) {
  const status = getErrorStatus(error);
  return status === 429 || status === 529;
}
__name(isTransientCapacityError, "isTransientCapacityError");
function isUnattendedMode() {
  const val = process.env["QWEN_CODE_UNATTENDED_RETRY"];
  return val === "true" || val === "1";
}
__name(isUnattendedMode, "isUnattendedMode");
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Retry aborted by signal"));
    }
    const cleanup = /* @__PURE__ */ __name(() => {
      signal?.removeEventListener("abort", onAbort);
    }, "cleanup");
    function onAbort() {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Retry aborted by signal"));
    }
    __name(onAbort, "onAbort");
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      clearTimeout(timeout);
      cleanup();
      reject(new Error("Retry aborted by signal"));
    }
  });
}
__name(delay, "delay");
async function sleepWithHeartbeat(totalMs, ctx) {
  let remaining = totalMs;
  while (remaining > 0) {
    if (ctx.signal?.aborted) {
      throw new Error("Retry aborted by signal");
    }
    const chunk = Math.max(1, Math.min(remaining, ctx.heartbeatInterval));
    await delay(chunk, ctx.signal);
    remaining -= chunk;
    if (remaining > 0 && ctx.heartbeatFn) {
      ctx.heartbeatFn({
        attempt: ctx.attempt,
        remainingMs: remaining,
        error: ctx.error
      });
    }
  }
}
__name(sleepWithHeartbeat, "sleepWithHeartbeat");
async function retryWithBackoff(fn, options) {
  if (options?.maxAttempts !== void 0 && options.maxAttempts <= 0) {
    throw new Error("maxAttempts must be a positive number.");
  }
  const cleanOptions = options ? Object.fromEntries(Object.entries(options).filter(([_, v]) => v != null)) : {};
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    authType,
    extraRetryErrorCodes,
    shouldRetryOnError,
    shouldRetryOnContent,
    persistentMode,
    persistentMaxBackoffMs,
    persistentCapMs,
    heartbeatIntervalMs,
    heartbeatFn,
    signal,
    onRetry
  } = {
    ...DEFAULT_RETRY_OPTIONS,
    ...cleanOptions
  };
  const hasCustomShouldRetryOnError = typeof options?.shouldRetryOnError === "function";
  const persistent = persistentMode ?? false;
  const maxBackoff = persistentMaxBackoffMs ?? PERSISTENT_MAX_BACKOFF_MS;
  const capMs = persistentCapMs ?? PERSISTENT_CAP_MS;
  const heartbeatInterval = heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let attempt = 0;
  let persistentAttempt = 0;
  let currentDelay = initialDelayMs;
  const requestEntryTime = Date.now();
  let iterationCount = 0;
  let retryTotalDelayMs = 0;
  let lastContentResult;
  let hadContentRetry = false;
  while (attempt < maxAttempts) {
    attempt++;
    iterationCount++;
    const requestSetupMs = Date.now() - requestEntryTime;
    try {
      const result = await retryContext.run(
        { attempt: iterationCount, retryTotalDelayMs, requestSetupMs },
        () => fn()
      );
      if (shouldRetryOnContent && shouldRetryOnContent(result)) {
        lastContentResult = result;
        hadContentRetry = true;
        const delayMs = getRetryDelayMs({
          // attempt: 1 — currentDelay already tracks exponential growth;
          // getRetryDelayMs is called here only for jitter calculation.
          attempt: 1,
          initialDelayMs: currentDelay,
          maxDelayMs,
          jitterRatio: 0.3
        });
        debugLogger.warn(
          `Attempt ${iterationCount}: response rejected by content check. Retrying with backoff in ${Math.ceil(delayMs / 1e3)}s...`
        );
        await delay(delayMs, signal);
        retryTotalDelayMs += delayMs;
        currentDelay = Math.min(maxDelayMs, currentDelay * 2);
        continue;
      }
      return result;
    } catch (error) {
      const errorStatus = getErrorStatus(error);
      const retryDiagnostics = classifyRetryError(error, {
        authType,
        extraRetryErrorCodes
      });
      if (retryDiagnostics.kind === "abort") {
        throw error;
      }
      if (authType === "qwen-oauth" /* QWEN_OAUTH */ && isQwenQuotaExceededError(error)) {
        debugLogger.error(
          "Qwen OAuth quota exceeded, fast-failing",
          retryDiagnostics,
          error
        );
        throw new Error(
          `Qwen OAuth free tier has been discontinued as of 2026-04-15.

To continue using Qwen Code, try one of these alternatives:
  - OpenRouter:    https://openrouter.ai/docs/quickstart
  - Fireworks AI:  https://docs.fireworks.ai/api-reference/introduction
  - ModelStudio:   https://help.aliyun.com/zh/model-studio/coding-plan

After setting up your API key, run /auth to configure your provider.`
        );
      }
      if (isQuotaExhaustedError(error)) {
        debugLogger.error(
          "Quota exhausted, fast-failing",
          retryDiagnostics,
          error
        );
        throw new Error(formatQuotaExhaustedMessage(error), { cause: error });
      }
      const isTransient = isTransientCapacityError(error);
      const callerAllowsRetry = hasCustomShouldRetryOnError ? shouldRetryOnError(error) : defaultShouldRetry(error, extraRetryErrorCodes);
      const isFailFast = retryDiagnostics.diagnosis === "fail-fast";
      const shouldPersist = persistent && isTransient && callerAllowsRetry && !isFailFast;
      if (!shouldPersist) {
        if (attempt >= maxAttempts || !callerAllowsRetry) {
          throw error;
        }
      }
      let delayMs;
      if (shouldPersist) {
        persistentAttempt++;
        const retryAfterMs = hasRetryAfterStatus(errorStatus) || error instanceof ResponsesHttpError ? getRetryAfterDelayMs(error) : null;
        if (retryAfterMs !== null && retryAfterMs > 0) {
          delayMs = Math.min(retryAfterMs, capMs);
        } else {
          delayMs = getRetryDelayMs({
            attempt: persistentAttempt,
            initialDelayMs,
            maxDelayMs: Math.min(maxBackoff, capMs),
            jitterRatio: 0.25
          });
        }
        const reportedAttempt = persistentAttempt;
        debugLogger.warn(
          `[Persistent] Attempt ${reportedAttempt} failed with status ${errorStatus ?? "unknown"}. Retrying in ${Math.ceil(delayMs / 1e3)}s...`,
          retryDiagnostics,
          error
        );
        if (!signal?.aborted) {
          try {
            onRetry?.({
              attempt: iterationCount,
              error,
              errorStatus,
              delayMs
            });
          } catch (cbError) {
            debugLogger.warn(
              `onRetry callback threw (swallowed): ${cbError instanceof Error ? cbError.message : String(cbError)}`
            );
          }
        }
        await sleepWithHeartbeat(delayMs, {
          attempt: reportedAttempt,
          error,
          heartbeatInterval,
          heartbeatFn,
          signal
        });
        retryTotalDelayMs += delayMs;
        if (attempt >= maxAttempts) {
          attempt = maxAttempts - 1;
        }
      } else {
        const retryAfterMs = hasRetryAfterStatus(errorStatus) || error instanceof ResponsesHttpError ? getRetryAfterDelayMs(error) : null;
        let actualDelayMs;
        if (retryAfterMs !== null && retryAfterMs > 0) {
          actualDelayMs = retryAfterMs;
          currentDelay = initialDelayMs;
          logRetryAtStatusLevel(
            `Attempt ${attempt} failed with status ${errorStatus ?? "unknown"}. Retrying after explicit delay of ${retryAfterMs}ms...`,
            retryDiagnostics,
            error,
            errorStatus
          );
        } else {
          actualDelayMs = getRetryDelayMs({
            // attempt: 1 — currentDelay already tracks exponential growth;
            // getRetryDelayMs is called here only for jitter calculation.
            attempt: 1,
            initialDelayMs: currentDelay,
            maxDelayMs,
            jitterRatio: 0.3
          });
          currentDelay = Math.min(maxDelayMs, currentDelay * 2);
          logRetryAttempt(
            attempt,
            error,
            retryDiagnostics,
            errorStatus,
            actualDelayMs
          );
        }
        if (!signal?.aborted) {
          try {
            onRetry?.({
              attempt: iterationCount,
              error,
              errorStatus,
              delayMs: actualDelayMs
            });
          } catch (cbError) {
            debugLogger.warn(
              `onRetry callback threw (swallowed): ${cbError instanceof Error ? cbError.message : String(cbError)}`
            );
          }
        }
        await delay(actualDelayMs, signal);
        retryTotalDelayMs += actualDelayMs;
      }
    }
  }
  if (hadContentRetry) {
    return lastContentResult;
  }
  throw new Error("Retry attempts exhausted");
}
__name(retryWithBackoff, "retryWithBackoff");
function logRetryAttempt(attempt, error, retryDiagnostics, errorStatus, delayMs) {
  const backoff = delayMs !== void 0 ? `Retrying with backoff in ${Math.ceil(delayMs / 1e3)}s...` : "Retrying with backoff...";
  const message = errorStatus ? `Attempt ${attempt} failed with status ${errorStatus}. ${backoff}` : `Attempt ${attempt} failed. ${backoff}`;
  logRetryAtStatusLevel(message, retryDiagnostics, error, errorStatus);
}
__name(logRetryAttempt, "logRetryAttempt");
function logRetryAtStatusLevel(message, retryDiagnostics, error, errorStatus) {
  if (errorStatus !== void 0 && errorStatus >= 500 && errorStatus < 600) {
    debugLogger.error(message, retryDiagnostics, error);
  } else {
    debugLogger.warn(message, retryDiagnostics, error);
  }
}
__name(logRetryAtStatusLevel, "logRetryAtStatusLevel");

export {
  retryContext,
  isUnattendedMode,
  delay,
  retryWithBackoff
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
