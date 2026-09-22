// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-webhook-ipc.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var CHANNEL_WEBHOOK_ENQUEUE_ERROR_CODES = /* @__PURE__ */ new Set([
  "channel_worker_unavailable",
  "channel_webhook_enqueue_timeout",
  "channel_webhook_queue_full",
  "channel_webhook_target_unavailable",
  "channel_webhook_invalid_task",
  "channel_webhook_enqueue_failed"
]);
var ChannelWebhookEnqueueError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ChannelWebhookEnqueueError";
  }
  static {
    __name(this, "ChannelWebhookEnqueueError");
  }
};
function isChannelWebhookEnqueueErrorCode(value) {
  return typeof value === "string" && CHANNEL_WEBHOOK_ENQUEUE_ERROR_CODES.has(value);
}
__name(isChannelWebhookEnqueueErrorCode, "isChannelWebhookEnqueueErrorCode");
function isChannelWebhookEnqueueError(value) {
  return value instanceof ChannelWebhookEnqueueError || typeof value === "object" && value !== null && isChannelWebhookEnqueueErrorCode(value.code) && typeof value.message === "string";
}
__name(isChannelWebhookEnqueueError, "isChannelWebhookEnqueueError");
var CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS = 3e4;
function createChannelWebhookTaskMessage(task) {
  return {
    type: "webhook_task",
    id: randomUUID(),
    expiresAt: Date.now() + CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS,
    task
  };
}
__name(createChannelWebhookTaskMessage, "createChannelWebhookTaskMessage");
function isChannelWebhookTaskMessage(value) {
  return typeof value === "object" && value !== null && value.type === "webhook_task" && typeof value.id === "string" && typeof value.expiresAt === "number" && typeof value.task === "object" && value.task !== null;
}
__name(isChannelWebhookTaskMessage, "isChannelWebhookTaskMessage");
function isChannelWebhookTaskResultMessage(value) {
  return typeof value === "object" && value !== null && value.type === "webhook_task_result" && typeof value.id === "string" && typeof value.ok === "boolean";
}
__name(isChannelWebhookTaskResultMessage, "isChannelWebhookTaskResultMessage");

// packages/cli/src/serve/channel-worker-startup-ipc.ts
init_esbuild_shims();
var MAX_CHANNEL_STARTUP_FAILURES = 64;
var MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH = 128;
var MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH = 64;
var MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH = 512;
function isBoundedNonEmptyString(value, maxLength) {
  if (typeof value !== "string" || value.length === 0) return false;
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maxLength) return false;
  }
  return true;
}
__name(isBoundedNonEmptyString, "isBoundedNonEmptyString");
function isChannelStartupFailure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const failure = value;
    return isBoundedNonEmptyString(
      failure["channel"],
      MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH
    ) && failure["phase"] === "connect" && (failure["code"] === void 0 || isBoundedNonEmptyString(
      failure["code"],
      MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH
    )) && isBoundedNonEmptyString(
      failure["message"],
      MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH
    );
  } catch {
    return false;
  }
}
__name(isChannelStartupFailure, "isChannelStartupFailure");
function isChannelStartupReportMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const message = value;
    if (message["type"] === "channel_startup_failures_truncated") {
      return true;
    }
    return message["type"] === "channel_startup_failure" && isChannelStartupFailure(message["failure"]);
  } catch {
    return false;
  }
}
__name(isChannelStartupReportMessage, "isChannelStartupReportMessage");
function isChannelStartupReportAckMessage(value) {
  try {
    return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "channel_startup_report_ack";
  } catch {
    return false;
  }
}
__name(isChannelStartupReportAckMessage, "isChannelStartupReportAckMessage");
function isChannelStartupReportType(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  try {
    const type = value.type;
    return type === "channel_startup_failure" || type === "channel_startup_failures_truncated";
  } catch {
    return false;
  }
}
__name(isChannelStartupReportType, "isChannelStartupReportType");

export {
  ChannelWebhookEnqueueError,
  isChannelWebhookEnqueueErrorCode,
  isChannelWebhookEnqueueError,
  CHANNEL_WEBHOOK_TASK_IPC_TIMEOUT_MS,
  createChannelWebhookTaskMessage,
  isChannelWebhookTaskMessage,
  isChannelWebhookTaskResultMessage,
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
  isChannelStartupReportMessage,
  isChannelStartupReportAckMessage,
  isChannelStartupReportType
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
