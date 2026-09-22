// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/cleanup.ts
init_esbuild_shims();
import { promises as fs } from "node:fs";
import { join } from "node:path";
var cleanupFunctions = [];
var exitCleanupPromise;
function registerCleanup(fn) {
  cleanupFunctions.push(fn);
  return () => {
    const index = cleanupFunctions.indexOf(fn);
    if (index !== -1) cleanupFunctions.splice(index, 1);
  };
}
__name(registerCleanup, "registerCleanup");
var PER_CLEANUP_TIMEOUT_MS = 2e3;
var OVERALL_CLEANUP_TIMEOUT_MS = 5e3;
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(void 0), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(void 0);
      }
    );
  });
}
__name(withTimeout, "withTimeout");
function runExitCleanup(options = {}) {
  if (exitCleanupPromise) return exitCleanupPromise;
  const cleanup = runExitCleanupPass(options).finally(() => {
    if (exitCleanupPromise === cleanup) exitCleanupPromise = void 0;
  });
  exitCleanupPromise = cleanup;
  return cleanup;
}
__name(runExitCleanup, "runExitCleanup");
async function runExitCleanupPass(options) {
  const perFn = options._testPerFnTimeoutMs ?? PER_CLEANUP_TIMEOUT_MS;
  const overall = options._testOverallTimeoutMs ?? OVERALL_CLEANUP_TIMEOUT_MS;
  const drain = (async () => {
    for (const fn of cleanupFunctions) {
      try {
        await withTimeout(Promise.resolve().then(fn), perFn);
      } catch (_) {
      }
    }
  })();
  let wallClockTimer;
  const wallClock = new Promise((resolve) => {
    wallClockTimer = setTimeout(() => resolve(), overall);
    wallClockTimer.unref?.();
  });
  try {
    await Promise.race([drain, wallClock]);
  } finally {
    if (wallClockTimer) clearTimeout(wallClockTimer);
    cleanupFunctions.length = 0;
  }
}
__name(runExitCleanupPass, "runExitCleanupPass");
async function cleanupCheckpoints() {
  const { Storage } = await import("./deferred-core-runtime-2IG4SLGP.js");
  const storage = new Storage(process.cwd());
  const tempDir = storage.getProjectTempDir();
  const checkpointsDir = join(tempDir, "checkpoints");
  try {
    await fs.rm(checkpointsDir, { recursive: true, force: true });
  } catch {
  }
}
__name(cleanupCheckpoints, "cleanupCheckpoints");

export {
  registerCleanup,
  runExitCleanup,
  cleanupCheckpoints
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
