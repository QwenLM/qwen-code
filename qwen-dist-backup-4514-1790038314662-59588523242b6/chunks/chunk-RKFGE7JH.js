// Force strict mode and setup for ESM
"use strict";
import {
  CHANNEL_DELIVERY_ERROR_CODES
} from "./chunk-UDG5EZJI.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/runtime/channel-delivery-ipc.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var ChannelDeliveryError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "ChannelDeliveryError";
  }
  static {
    __name(this, "ChannelDeliveryError");
  }
};
function isChannelDeliveryErrorCode(value) {
  return typeof value === "string" && CHANNEL_DELIVERY_ERROR_CODES.has(value);
}
__name(isChannelDeliveryErrorCode, "isChannelDeliveryErrorCode");
function isChannelDeliveryError(value) {
  return value instanceof ChannelDeliveryError || typeof value === "object" && value !== null && isChannelDeliveryErrorCode(value.code) && typeof value.message === "string";
}
__name(isChannelDeliveryError, "isChannelDeliveryError");
var CHANNEL_DELIVERY_IPC_TIMEOUT_MS = 3e4;
var MAX_CHANNEL_DELIVERIES_IN_FLIGHT = 16;
var MAX_CHANNEL_DELIVERY_TEXT_LENGTH = 1e5;
function createChannelDeliveryMessage(request) {
  return {
    type: "channel_delivery",
    id: randomUUID(),
    expiresAt: Date.now() + CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
    request
  };
}
__name(createChannelDeliveryMessage, "createChannelDeliveryMessage");
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
__name(isNonEmptyString, "isNonEmptyString");
function isChannelDeliveryTarget(value) {
  if (typeof value !== "object" || value === null) return false;
  const target = value;
  return (target["type"] === "user" || target["type"] === "chat") && isNonEmptyString(target["id"]) && Object.keys(target).every((key) => key === "type" || key === "id");
}
__name(isChannelDeliveryTarget, "isChannelDeliveryTarget");
function isChannelDeliveryRequest(value) {
  if (typeof value !== "object" || value === null) return false;
  const request = value;
  return isNonEmptyString(request["deliveryId"]) && isNonEmptyString(request["channelName"]) && isChannelDeliveryTarget(request["target"]) && isNonEmptyString(request["text"]) && request["text"].length <= MAX_CHANNEL_DELIVERY_TEXT_LENGTH;
}
__name(isChannelDeliveryRequest, "isChannelDeliveryRequest");
function isChannelDeliveryMessage(value) {
  if (typeof value !== "object" || value === null) return false;
  const message = value;
  return message["type"] === "channel_delivery" && isNonEmptyString(message["id"]) && typeof message["expiresAt"] === "number" && Number.isFinite(message["expiresAt"]) && isChannelDeliveryRequest(message["request"]);
}
__name(isChannelDeliveryMessage, "isChannelDeliveryMessage");
function isChannelDeliveryResultMessage(value) {
  if (typeof value !== "object" || value === null) return false;
  const message = value;
  if (message["type"] !== "channel_delivery_result" || !isNonEmptyString(message["id"]) || typeof message["ok"] !== "boolean") {
    return false;
  }
  if (message["ok"]) return true;
  return isChannelDeliveryErrorCode(message["code"]) && typeof message["error"] === "string";
}
__name(isChannelDeliveryResultMessage, "isChannelDeliveryResultMessage");

export {
  ChannelDeliveryError,
  isChannelDeliveryError,
  CHANNEL_DELIVERY_IPC_TIMEOUT_MS,
  MAX_CHANNEL_DELIVERIES_IN_FLIGHT,
  MAX_CHANNEL_DELIVERY_TEXT_LENGTH,
  createChannelDeliveryMessage,
  isChannelDeliveryMessage,
  isChannelDeliveryResultMessage
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
