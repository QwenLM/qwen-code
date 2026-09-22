// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/code-mode/protocol.ts
init_esbuild_shims();
var CODE_MODE_MAX_CONTROL_FRAME_BYTES = 1048576;
var CODE_MODE_MAX_FRAME_BYTES = 16 * 1024 * 1024;
var CODE_MODE_MAX_MEDIA_BYTES = 10 * 1024 * 1024;
var CODE_MODE_MAX_MEDIA_ITEMS = 16;
var CODE_MODE_MAX_SOURCE_CHARS = 131072;
var CODE_MODE_MAX_OUTPUT_CHARS = 1e5;
var CODE_MODE_TIMEOUT_MS = 3e4;
function hasBoundedImageContent(message) {
  if (message.type !== "tool_result") return false;
  const content = message.result?.content;
  if (!Array.isArray(content) || content.length === 0 || content.length > CODE_MODE_MAX_MEDIA_ITEMS) {
    return false;
  }
  let decodedBytes = 0;
  for (const item of content) {
    if (item?.type !== "image" || typeof item.mimeType !== "string" || !item.mimeType.toLowerCase().startsWith("image/") || typeof item.data !== "string" || item.data.length === 0) {
      return false;
    }
    const padding = item.data.endsWith("==") ? 2 : item.data.endsWith("=") ? 1 : 0;
    decodedBytes += Math.floor(item.data.length * 3 / 4) - padding;
    if (decodedBytes > CODE_MODE_MAX_MEDIA_BYTES) return false;
  }
  return true;
}
__name(hasBoundedImageContent, "hasBoundedImageContent");
function maxFrameBytes(message) {
  if (message.type === "complete" || message.type === "error") {
    return CODE_MODE_MAX_FRAME_BYTES;
  }
  if (hasBoundedImageContent(message)) return CODE_MODE_MAX_FRAME_BYTES;
  return CODE_MODE_MAX_CONTROL_FRAME_BYTES;
}
__name(maxFrameBytes, "maxFrameBytes");
function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.byteLength > maxFrameBytes(message)) {
    throw new Error("Code mode protocol frame exceeds the size limit.");
  }
  const frame = Buffer.allocUnsafe(body.byteLength + 4);
  frame.writeUInt32BE(body.byteLength, 0);
  body.copy(frame, 4);
  return frame;
}
__name(encodeFrame, "encodeFrame");
var FrameDecoder = class {
  static {
    __name(this, "FrameDecoder");
  }
  buffer = Buffer.alloc(0);
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const messages = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > CODE_MODE_MAX_FRAME_BYTES) {
        throw new Error("Code mode protocol frame exceeds the size limit.");
      }
      if (this.buffer.byteLength < length + 4) break;
      const body = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const message = JSON.parse(body.toString("utf8"));
      if (length > maxFrameBytes(message)) {
        throw new Error("Code mode protocol frame exceeds the size limit.");
      }
      messages.push(message);
    }
    return messages;
  }
};

export {
  CODE_MODE_MAX_MEDIA_BYTES,
  CODE_MODE_MAX_MEDIA_ITEMS,
  CODE_MODE_MAX_SOURCE_CHARS,
  CODE_MODE_MAX_OUTPUT_CHARS,
  CODE_MODE_TIMEOUT_MS,
  encodeFrame,
  FrameDecoder
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
