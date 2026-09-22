// Force strict mode and setup for ESM
"use strict";
import {
  CoreToolScheduler
} from "./chunk-MRTRBONQ.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/nonInteractiveToolExecutor.ts
init_esbuild_shims();
async function executeToolCall(config, toolCallRequest, abortSignal, options = {}) {
  return new Promise((resolve, reject) => {
    new CoreToolScheduler({
      config,
      chatRecordingService: options.recordToolResult === false ? void 0 : config.getChatRecordingService(),
      outputUpdateHandler: options.outputUpdateHandler,
      onAllToolCallsComplete: /* @__PURE__ */ __name(async (completedToolCalls) => {
        if (options.onAllToolCallsComplete) {
          await options.onAllToolCallsComplete(completedToolCalls);
        }
        resolve(completedToolCalls[0].response);
      }, "onAllToolCallsComplete"),
      onToolCallsUpdate: options.onToolCallsUpdate,
      onToolResultFullTurnModel: options.onToolResultFullTurnModel,
      getPreferredEditor: /* @__PURE__ */ __name(() => void 0, "getPreferredEditor"),
      onEditorClose: /* @__PURE__ */ __name(() => {
      }, "onEditorClose")
    }).schedule(toolCallRequest, abortSignal, options.runtimeView).catch(reject);
  });
}
__name(executeToolCall, "executeToolCall");

export {
  executeToolCall
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
