// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/abortController.ts
init_esbuild_shims();
import { setMaxListeners } from "node:events";
var DEFAULT_MAX_LISTENERS = 50;
function createAbortController(maxListeners = DEFAULT_MAX_LISTENERS) {
  const controller = new AbortController();
  setMaxListeners(maxListeners, controller.signal);
  return controller;
}
__name(createAbortController, "createAbortController");
function asSignal(parent) {
  if (!parent) return void 0;
  return parent instanceof AbortController ? parent.signal : parent;
}
__name(asSignal, "asSignal");
function createChildAbortController(parent, maxListeners) {
  const child = createAbortController(maxListeners);
  const parentSignal = asSignal(parent);
  if (!parentSignal) return child;
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return child;
  }
  const weakParent = new WeakRef(parentSignal);
  const handler = /* @__PURE__ */ __name(() => {
    child.abort(weakParent.deref()?.reason);
  }, "handler");
  parentSignal.addEventListener("abort", handler, { once: true });
  child.signal.addEventListener(
    "abort",
    () => {
      weakParent.deref()?.removeEventListener("abort", handler);
    },
    { once: true }
  );
  return child;
}
__name(createChildAbortController, "createChildAbortController");
function combineAbortSignals(signals, options) {
  const controller = createAbortController(options?.maxListeners);
  const alreadyAborted = signals.find((s) => s?.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return { signal: controller.signal, cleanup: /* @__PURE__ */ __name(() => {
    }, "cleanup") };
  }
  const cleanups = [];
  for (const sourceSignal of signals) {
    if (!sourceSignal) continue;
    if (sourceSignal.aborted) {
      controller.abort(sourceSignal.reason);
      break;
    }
    const handler = /* @__PURE__ */ __name(() => controller.abort(sourceSignal.reason), "handler");
    sourceSignal.addEventListener("abort", handler, { once: true });
    cleanups.push(() => sourceSignal.removeEventListener("abort", handler));
  }
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== void 0 && timeoutMs > 0 && !controller.signal.aborted) {
    const timeoutId = setTimeout(() => {
      controller.abort(new DOMException("Operation timed out", "TimeoutError"));
    }, timeoutMs);
    cleanups.push(() => clearTimeout(timeoutId));
  }
  let done = false;
  const cleanup = /* @__PURE__ */ __name(() => {
    if (done) return;
    done = true;
    for (const fn of cleanups) fn();
  }, "cleanup");
  if (controller.signal.aborted) {
    cleanup();
  } else {
    controller.signal.addEventListener("abort", cleanup, { once: true });
  }
  return { signal: controller.signal, cleanup };
}
__name(combineAbortSignals, "combineAbortSignals");

export {
  createAbortController,
  createChildAbortController,
  combineAbortSignals
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
