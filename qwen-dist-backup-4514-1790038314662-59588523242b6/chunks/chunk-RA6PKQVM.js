// Force strict mode and setup for ESM
"use strict";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/nonInteractive/chat-recording-failure.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var CHAT_RECORDING_FAILURE_MESSAGE = "Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then start a new session to resume recording. See the debug log for details.";
var TUI_CHAT_RECORDING_FAILURE_MESSAGE = "Session recording stopped after a write failure. New messages for the affected session will not be saved. Check disk space and permissions, then run `/clear` to start a new recorded session. See the debug log for details.";
var CHAT_RECORDING_SETTLE_TIMEOUT_MS = 2e3;
var debugLogger = createDebugLogger("CHAT_RECORDING");
function createChatRecordingFailureSystemMessage(event) {
  return {
    type: "system",
    subtype: "session_recording_degraded",
    uuid: randomUUID(),
    session_id: event.sessionId,
    parent_tool_use_id: null,
    data: {
      session_id: event.sessionId,
      reason: "write_failed",
      message: CHAT_RECORDING_FAILURE_MESSAGE
    }
  };
}
__name(createChatRecordingFailureSystemMessage, "createChatRecordingFailureSystemMessage");
function reportChatRecordingFailureToAdapter(adapter, event) {
  adapter.emitMessage(createChatRecordingFailureSystemMessage(event));
}
__name(reportChatRecordingFailureToAdapter, "reportChatRecordingFailureToAdapter");
function subscribeToHeadlessChatRecordingFailures(config, adapter) {
  if (typeof config.onChatRecordingFailure !== "function") return () => {
  };
  return config.onChatRecordingFailure((event) => {
    if (config.getOutputFormat() === "text" /* TEXT */) {
      writeStderrLine(`Warning: ${t(CHAT_RECORDING_FAILURE_MESSAGE)}`);
      return;
    }
    reportChatRecordingFailureToAdapter(adapter, event);
  });
}
__name(subscribeToHeadlessChatRecordingFailures, "subscribeToHeadlessChatRecordingFailures");
async function settleChatRecording(config, options) {
  if (typeof config.getChatRecordingService !== "function") return "settled";
  const recorder = config.getChatRecordingService();
  if (!recorder) return "settled";
  if (options.finalize) recorder.finalize();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      debugLogger.debug("Timed out waiting for chat recording to flush");
      resolve("timeout");
    }, CHAT_RECORDING_SETTLE_TIMEOUT_MS);
  });
  const settled = recorder.flush().then(
    () => "settled",
    () => "settled"
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
__name(settleChatRecording, "settleChatRecording");

export {
  TUI_CHAT_RECORDING_FAILURE_MESSAGE,
  reportChatRecordingFailureToAdapter,
  subscribeToHeadlessChatRecordingFailures,
  settleChatRecording
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
