// Force strict mode and setup for ESM
"use strict";
import {
  SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX
} from "./chunk-7RZUXNH6.js";
import {
  ChannelDeliveryError,
  MAX_CHANNEL_DELIVERY_TEXT_LENGTH
} from "./chunk-RKFGE7JH.js";
import {
  MAX_CHANNEL_DELIVERY_NAME_LENGTH,
  MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH
} from "./chunk-C4FISGDN.js";
import {
  stripTerminalControlSequences
} from "./chunk-IMV5DBIP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/runtime/channel-delivery.ts
init_esbuild_shims();
var TRUNCATED_TEXT_SUFFIX = "\n\n[Channel delivery truncated because the result exceeded the delivery size limit.]";
function isBoundedString(value, maxLength) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}
__name(isBoundedString, "isBoundedString");
function parseChannelDelivery(value) {
  if (typeof value !== "object" || value === null) {
    throw new ChannelDeliveryError(
      "channel_delivery_invalid",
      "Invalid channel delivery."
    );
  }
  const delivery = value;
  const rawTarget = delivery["target"];
  if (delivery["kind"] !== "channel" || typeof rawTarget !== "object" || rawTarget === null || !Object.keys(delivery).every((key) => key === "kind" || key === "target")) {
    throw new ChannelDeliveryError(
      "channel_delivery_invalid",
      "Invalid channel delivery."
    );
  }
  const target = rawTarget;
  if (!isBoundedString(target["channelName"], MAX_CHANNEL_DELIVERY_NAME_LENGTH) || target["type"] !== "user" && target["type"] !== "chat" || !isBoundedString(target["id"], MAX_CHANNEL_DELIVERY_TARGET_ID_LENGTH) || !Object.keys(target).every(
    (key) => key === "channelName" || key === "type" || key === "id"
  )) {
    throw new ChannelDeliveryError(
      "channel_delivery_invalid",
      "Invalid channel delivery."
    );
  }
  return {
    kind: "channel",
    target: {
      channelName: target["channelName"],
      type: target["type"],
      id: target["id"]
    }
  };
}
__name(parseChannelDelivery, "parseChannelDelivery");
function normalizeChannelDeliveryText(text) {
  if (text.length <= MAX_CHANNEL_DELIVERY_TEXT_LENGTH) return text;
  const prefixLimit = MAX_CHANNEL_DELIVERY_TEXT_LENGTH - TRUNCATED_TEXT_SUFFIX.length;
  let prefix = text.slice(0, prefixLimit);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 55296 && lastCodeUnit <= 56319) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${TRUNCATED_TEXT_SUFFIX}`;
}
__name(normalizeChannelDeliveryText, "normalizeChannelDeliveryText");
function normalizeChannelDelivery(deliveryId, delivery, text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new ChannelDeliveryError(
      "channel_delivery_invalid",
      "Channel delivery text is empty."
    );
  }
  return {
    deliveryId,
    channelName: delivery.target.channelName,
    target: { type: delivery.target.type, id: delivery.target.id },
    text: normalizeChannelDeliveryText(text)
  };
}
__name(normalizeChannelDelivery, "normalizeChannelDelivery");

// packages/cli/src/runtime/scheduled-task-run.ts
init_esbuild_shims();
function scheduledTaskRunSourceId(taskId) {
  return `${SCHEDULED_TASK_RUN_SOURCE_ID_PREFIX}${taskId}`;
}
__name(scheduledTaskRunSourceId, "scheduledTaskRunSourceId");
var SCHEDULED_TASK_RUN_INSTRUCTION = "This is a scheduled task run. Execute the instructions below now. Do not create or modify a schedule unless the instructions explicitly ask you to.";
function cleanMetadataLine(value) {
  return stripTerminalControlSequences(value).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim().replace(/\s+/g, " ");
}
__name(cleanMetadataLine, "cleanMetadataLine");
var MAX_RUN_SESSION_NAME_LENGTH = 60;
function pad2(n) {
  return String(n).padStart(2, "0");
}
__name(pad2, "pad2");
function scheduledTaskRunSessionName(label, triggeredAt) {
  const at = new Date(triggeredAt);
  const suffix = ` \xB7 ${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(
    at.getHours()
  )}:${pad2(at.getMinutes())}`;
  const cleaned = cleanMetadataLine(label);
  const budget = MAX_RUN_SESSION_NAME_LENGTH - suffix.length;
  let short = cleaned;
  if (cleaned.length > budget) {
    let cut = budget - 1;
    const boundary = cleaned.charCodeAt(cut - 1);
    if (boundary >= 55296 && boundary <= 56319) cut -= 1;
    short = `${cleaned.slice(0, cut)}\u2026`;
  }
  return `${short}${suffix}`;
}
__name(scheduledTaskRunSessionName, "scheduledTaskRunSessionName");
function buildScheduledTaskRunPrompt(input) {
  const name = cleanMetadataLine(input.name ?? input.id) || input.id;
  const cron = cleanMetadataLine(input.cron);
  return [
    `Scheduled task: ${name}`,
    `Task ID: ${input.id}`,
    `Schedule: ${cron}`,
    `Triggered at: ${new Date(input.triggeredAt).toISOString()}`,
    `Trigger: ${input.trigger}`,
    "Session: new chat for this run",
    "",
    SCHEDULED_TASK_RUN_INSTRUCTION,
    "",
    input.prompt
  ].join("\n");
}
__name(buildScheduledTaskRunPrompt, "buildScheduledTaskRunPrompt");

export {
  parseChannelDelivery,
  normalizeChannelDeliveryText,
  normalizeChannelDelivery,
  scheduledTaskRunSourceId,
  scheduledTaskRunSessionName,
  buildScheduledTaskRunPrompt
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
