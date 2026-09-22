// Force strict mode and setup for ESM
"use strict";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV
} from "./chunk-TLS6QN2S.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/tool-call-arguments.ts
init_esbuild_shims();
function parseToolCallArguments(json) {
  try {
    const value = JSON.parse(json);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, reason: "NON_OBJECT" };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, reason: "MALFORMED_JSON" };
  }
}
__name(parseToolCallArguments, "parseToolCallArguments");

// packages/core/src/core/stream-guards.ts
init_esbuild_shims();
var StreamInactivityTimeoutError = class extends Error {
  constructor(idleMs, chunksReceived, streamLifetimeMs) {
    super(
      `No stream activity for ${idleMs}ms after ${chunksReceived} chunks (stream lifetime: ${streamLifetimeMs}ms). For provider-backed models, increase modelProviders[providerId][].generationConfig.streamIdleTimeoutMs; provider configuration takes precedence, so model.generationConfig is ignored for those models. For runtime models, increase model.generationConfig.streamIdleTimeoutMs. Built-in Qwen OAuth models cannot be overridden via settings. Use ${QWEN_STREAM_IDLE_TIMEOUT_MS_ENV} for them or whenever no explicit value is active. Set the active value to 0 to disable it.`
    );
    this.idleMs = idleMs;
    this.chunksReceived = chunksReceived;
    this.streamLifetimeMs = streamLifetimeMs;
    this.name = "StreamInactivityTimeoutError";
  }
  static {
    __name(this, "StreamInactivityTimeoutError");
  }
  code = "ETIMEDOUT";
};
var StreamLifetimeExceededError = class extends Error {
  constructor(maxLifetimeMs, chunksReceived, streamLifetimeMs) {
    super(
      `Stream exceeded its ${maxLifetimeMs}ms upstream-wait cap after ${chunksReceived} chunks without completing (wall clock: ${streamLifetimeMs}ms). Set ${QWEN_STREAM_MAX_LIFETIME_MS_ENV} to increase this cap (or 0 to disable it).`
    );
    this.maxLifetimeMs = maxLifetimeMs;
    this.chunksReceived = chunksReceived;
    this.streamLifetimeMs = streamLifetimeMs;
    this.name = "StreamLifetimeExceededError";
  }
  static {
    __name(this, "StreamLifetimeExceededError");
  }
  code = "ETIMEDOUT";
};
function resolveStreamGuardMs(fromConfig, configLabel, envName, defaultMs) {
  if (typeof fromConfig === "number") {
    if (Number.isInteger(fromConfig) && fromConfig <= MAX_STREAM_GUARD_TIMEOUT_MS) {
      return fromConfig;
    }
    console.warn(
      `[qwen-code] Ignoring out-of-range ${configLabel}=${fromConfig} (expected an integer in (-\u221E, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); falling back to ${envName}/default.`
    );
  }
  const raw = process.env[envName];
  const trimmed = raw?.trim();
  if (trimmed) {
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (parsed <= MAX_STREAM_GUARD_TIMEOUT_MS) {
        return parsed;
      }
    }
    console.warn(
      `[qwen-code] Ignoring invalid ${envName}="${raw}" (expected an integer of milliseconds in [0, ${MAX_STREAM_GUARD_TIMEOUT_MS}]); using default ${defaultMs}ms.`
    );
  }
  return defaultMs;
}
__name(resolveStreamGuardMs, "resolveStreamGuardMs");
function resolveStreamIdleTimeoutMs(config) {
  return resolveStreamGuardMs(
    config.streamIdleTimeoutMs,
    "streamIdleTimeoutMs",
    QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS
  );
}
__name(resolveStreamIdleTimeoutMs, "resolveStreamIdleTimeoutMs");
function resolveStreamMaxLifetimeMs(config) {
  return resolveStreamGuardMs(
    config.streamMaxLifetimeMs,
    "streamMaxLifetimeMs",
    QWEN_STREAM_MAX_LIFETIME_MS_ENV,
    DEFAULT_STREAM_MAX_LIFETIME_MS
  );
}
__name(resolveStreamMaxLifetimeMs, "resolveStreamMaxLifetimeMs");
async function* withStreamGuards(source, idleMs, maxLifetimeMs, abortRequest, parentSignal) {
  if (idleMs <= 0 && maxLifetimeMs <= 0) {
    yield* source;
    return;
  }
  const it = source[Symbol.asyncIterator]();
  const streamStartedAt = performance.now();
  let upstreamMs = 0;
  let chunksReceived = 0;
  try {
    while (true) {
      const remainingMs = maxLifetimeMs > 0 ? maxLifetimeMs - upstreamMs : Number.POSITIVE_INFINITY;
      if (remainingMs <= 0) {
        if (parentSignal?.aborted) {
          const abortErr = new Error("Aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        }
        abortRequest();
        throw new StreamLifetimeExceededError(
          maxLifetimeMs,
          chunksReceived,
          performance.now() - streamStartedAt
        );
      }
      const nextPromise = it.next();
      const awaitedAt = performance.now();
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        const idleIn = idleMs > 0 ? idleMs : Number.POSITIVE_INFINITY;
        const wait = Math.min(idleIn, remainingMs);
        timer = setTimeout(
          () => {
            if (parentSignal?.aborted) {
              const abortErr = new Error("Aborted");
              abortErr.name = "AbortError";
              reject(abortErr);
            } else if (remainingMs <= idleIn) {
              abortRequest();
              reject(
                new StreamLifetimeExceededError(
                  maxLifetimeMs,
                  chunksReceived,
                  performance.now() - streamStartedAt
                )
              );
            } else {
              abortRequest();
              reject(
                new StreamInactivityTimeoutError(
                  idleMs,
                  chunksReceived,
                  performance.now() - streamStartedAt
                )
              );
            }
          },
          Math.max(wait, 0)
        );
        timer.unref?.();
      });
      let result;
      try {
        result = await Promise.race([nextPromise, timeout]);
      } catch (err) {
        void Promise.resolve(nextPromise).catch(() => {
        });
        throw err;
      } finally {
        if (timer !== void 0) clearTimeout(timer);
      }
      if (result.done) return;
      upstreamMs += performance.now() - awaitedAt;
      chunksReceived += 1;
      yield result.value;
    }
  } finally {
    abortRequest();
    try {
      await it.return?.();
    } catch {
    }
  }
}
__name(withStreamGuards, "withStreamGuards");

export {
  parseToolCallArguments,
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
  resolveStreamIdleTimeoutMs,
  resolveStreamMaxLifetimeMs,
  withStreamGuards
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
