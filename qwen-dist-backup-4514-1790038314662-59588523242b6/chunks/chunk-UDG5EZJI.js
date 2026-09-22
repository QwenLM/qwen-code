// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";

// packages/acp-bridge/src/bridgeOptions.ts
init_esbuild_shims();
var MAX_SUB_SESSION_NAME_CHARS = 200;
var MAX_LIVE_SCREEN_CONTEXT_TEXT_CHARS = 32e3;
var LIVE_TASK_TOOL_NAMES = [
  "list_threads",
  "read_thread",
  "wait_threads",
  "send_message_to_thread",
  "create_thread"
];
var MAX_LIVE_SPEAK_TO_USER_MESSAGE_CHARS = 32e3;
var CHANNEL_DELIVERY_ERROR_CODES = /* @__PURE__ */ new Set([
  "channel_worker_unavailable",
  "channel_delivery_timeout",
  "channel_delivery_invalid",
  "channel_delivery_rejected",
  "channel_delivery_queue_full",
  "channel_delivery_failed"
]);

export {
  MAX_SUB_SESSION_NAME_CHARS,
  MAX_LIVE_SCREEN_CONTEXT_TEXT_CHARS,
  LIVE_TASK_TOOL_NAMES,
  MAX_LIVE_SPEAK_TO_USER_MESSAGE_CHARS,
  CHANNEL_DELIVERY_ERROR_CODES
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
