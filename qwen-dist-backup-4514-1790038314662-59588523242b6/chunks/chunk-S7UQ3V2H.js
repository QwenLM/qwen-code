// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/core/tool-call-preparation.ts
init_esbuild_shims();
var preparationsByResponse = /* @__PURE__ */ new WeakMap();
function setToolCallPreparations(response, preparations) {
  preparationsByResponse.set(response, preparations);
}
__name(setToolCallPreparations, "setToolCallPreparations");
function getToolCallPreparations(response) {
  return preparationsByResponse.get(response) ?? [];
}
__name(getToolCallPreparations, "getToolCallPreparations");

// packages/core/src/core/invalid-stream-error.ts
init_esbuild_shims();
var InvalidStreamError = class extends Error {
  static {
    __name(this, "InvalidStreamError");
  }
  type;
  constructor(message, type) {
    super(message);
    this.name = "InvalidStreamError";
    this.type = type;
  }
};

// packages/core/src/core/stream-transport-retry.ts
init_esbuild_shims();
var RETRYABLE_STREAM_TRANSPORT_CODES = /* @__PURE__ */ new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);
function isRetryableStreamTransportError(classification) {
  return classification.kind === "transport" && classification.transportCode !== void 0 && RETRYABLE_STREAM_TRANSPORT_CODES.has(classification.transportCode);
}
__name(isRetryableStreamTransportError, "isRetryableStreamTransportError");
function isRetryableStatuslessUpstreamError(classification) {
  return classification.reason === "upstream-error-without-status";
}
__name(isRetryableStatuslessUpstreamError, "isRetryableStatuslessUpstreamError");
var flushedToolCallParks = /* @__PURE__ */ new WeakMap();
function markFlushedToolCallPark(response) {
  flushedToolCallParks.set(response, true);
}
__name(markFlushedToolCallPark, "markFlushedToolCallPark");
function isFlushedToolCallPark(response) {
  return flushedToolCallParks.get(response) === true;
}
__name(isFlushedToolCallPark, "isFlushedToolCallPark");

export {
  setToolCallPreparations,
  getToolCallPreparations,
  InvalidStreamError,
  isRetryableStreamTransportError,
  isRetryableStatuslessUpstreamError,
  markFlushedToolCallPark,
  isFlushedToolCallPark
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
