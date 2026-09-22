// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/dist/session-restore-timeout.js
init_esbuild_shims();
var DEFAULT_SESSION_RESTORE_TIMEOUT_MS = 6e4;
var MAX_SESSION_RESTORE_TIMEOUT_MS = 2147483647;
var MIN_RESTORE_RETRY_AFTER_SECONDS = 5;
var MAX_RESTORE_RETRY_AFTER_SECONDS = 120;
function restoreRetryAfterSeconds(timeoutMs) {
  return Math.min(MAX_RESTORE_RETRY_AFTER_SECONDS, Math.max(MIN_RESTORE_RETRY_AFTER_SECONDS, Math.ceil(timeoutMs / 1e3)));
}
__name(restoreRetryAfterSeconds, "restoreRetryAfterSeconds");
function assertValidTimeoutMs(field, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_SESSION_RESTORE_TIMEOUT_MS) {
    throw new TypeError(`Invalid ${field}: ${timeoutMs}. Must be a positive integer no greater than ${MAX_SESSION_RESTORE_TIMEOUT_MS}.`);
  }
}
__name(assertValidTimeoutMs, "assertValidTimeoutMs");
function resolveSessionRestoreTimeoutMs(opts) {
  if (opts.sessionRestoreTimeoutMs !== void 0) {
    assertValidTimeoutMs("sessionRestoreTimeoutMs", opts.sessionRestoreTimeoutMs);
    return opts.sessionRestoreTimeoutMs;
  }
  if (opts.initializeTimeoutMs !== void 0) {
    assertValidTimeoutMs("initializeTimeoutMs", opts.initializeTimeoutMs);
    return Math.max(opts.initializeTimeoutMs, DEFAULT_SESSION_RESTORE_TIMEOUT_MS);
  }
  return DEFAULT_SESSION_RESTORE_TIMEOUT_MS;
}
__name(resolveSessionRestoreTimeoutMs, "resolveSessionRestoreTimeoutMs");

export {
  MAX_SESSION_RESTORE_TIMEOUT_MS,
  restoreRetryAfterSeconds,
  resolveSessionRestoreTimeoutMs
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
