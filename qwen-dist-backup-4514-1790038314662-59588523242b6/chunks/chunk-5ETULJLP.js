// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/invocation-context.ts
init_esbuild_shims();
import { AsyncLocalStorage } from "node:async_hooks";
var INVOCATION_CONTEXT_META_KEY = "qwen-code/invocation";
var PRIVATE_PARENT_CAPABILITY_META_KEY = "qwen-code/private-parent-capability";
var PRIVATE_ACP_CAPABILITY_ENV = "QWEN_CODE_PRIVATE_ACP_CAPABILITY";
var invocationContextKeys = /* @__PURE__ */ new Set([
  "version",
  "sessionId",
  "promptId",
  "originatorClientId"
]);
var invocationContextStorage = new AsyncLocalStorage();
function isNonBlankString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
__name(isNonBlankString, "isNonBlankString");
function parseInvocationContext(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return void 0;
  }
  const record = value;
  if (Object.keys(record).some((key) => !invocationContextKeys.has(key))) {
    return void 0;
  }
  if (record["version"] !== 1 || !isNonBlankString(record["sessionId"]) || !isNonBlankString(record["promptId"])) {
    return void 0;
  }
  let originatorClientId;
  if (Object.hasOwn(record, "originatorClientId")) {
    if (!isNonBlankString(record["originatorClientId"])) {
      return void 0;
    }
    originatorClientId = record["originatorClientId"];
  }
  return Object.freeze({
    version: 1,
    sessionId: record["sessionId"],
    promptId: record["promptId"],
    ...originatorClientId ? { originatorClientId } : {}
  });
}
__name(parseInvocationContext, "parseInvocationContext");
function runWithInvocationContext(context, callback) {
  return invocationContextStorage.run(context, callback);
}
__name(runWithInvocationContext, "runWithInvocationContext");
function getInvocationContext() {
  return invocationContextStorage.getStore();
}
__name(getInvocationContext, "getInvocationContext");

export {
  INVOCATION_CONTEXT_META_KEY,
  PRIVATE_PARENT_CAPABILITY_META_KEY,
  PRIVATE_ACP_CAPABILITY_ENV,
  parseInvocationContext,
  runWithInvocationContext,
  getInvocationContext
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
