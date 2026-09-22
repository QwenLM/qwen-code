// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/code-mode/tool-call-runtime.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var CodeModeTurnTerminated = class extends Error {
  static {
    __name(this, "CodeModeTurnTerminated");
  }
};
function extractCodeModeImageContent(parts) {
  const content = [];
  const appendImage = /* @__PURE__ */ __name((part) => {
    const inlineData = part.inlineData;
    if (inlineData?.mimeType?.toLowerCase().startsWith("image/") && inlineData.data) {
      content.push({
        type: "image",
        mimeType: inlineData.mimeType,
        data: inlineData.data
      });
    }
  }, "appendImage");
  for (const part of parts) {
    appendImage(part);
    for (const nested of part.functionResponse?.parts ?? []) {
      appendImage(nested);
    }
  }
  return content.length > 0 ? content : void 0;
}
__name(extractCodeModeImageContent, "extractCodeModeImageContent");
var context = new AsyncLocalStorage();
function runWithToolCallRuntime(runtime, fn) {
  return context.run(runtime, fn);
}
__name(runWithToolCallRuntime, "runWithToolCallRuntime");
function runWithoutToolCallRuntime(fn) {
  return context.exit(fn);
}
__name(runWithoutToolCallRuntime, "runWithoutToolCallRuntime");
function getToolCallRuntime() {
  return context.getStore();
}
__name(getToolCallRuntime, "getToolCallRuntime");
var sourceStorage = new AsyncLocalStorage();
function runWithToolCallSource(source, callback) {
  return sourceStorage.run(source, callback);
}
__name(runWithToolCallSource, "runWithToolCallSource");
function getCurrentToolCallSource() {
  return sourceStorage.getStore();
}
__name(getCurrentToolCallSource, "getCurrentToolCallSource");

export {
  CodeModeTurnTerminated,
  extractCodeModeImageContent,
  runWithToolCallRuntime,
  runWithoutToolCallRuntime,
  getToolCallRuntime,
  runWithToolCallSource,
  getCurrentToolCallSource
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
