// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/session-id.ts
init_esbuild_shims();
var INTERNAL_SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(-agent-[a-zA-Z0-9_.-]+)?$/i;
var CALLER_SUPPLIED_SESSION_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidSessionId(value) {
  return INTERNAL_SESSION_ID_REGEX.test(value);
}
__name(isValidSessionId, "isValidSessionId");
function normalizeSessionIdForLookup(value) {
  return CALLER_SUPPLIED_SESSION_ID_REGEX.test(value) ? value.toLowerCase() : value;
}
__name(normalizeSessionIdForLookup, "normalizeSessionIdForLookup");
function parseCallerSuppliedSessionId(value) {
  if (value === void 0 || value === null) return { kind: "absent" };
  if (typeof value !== "string" || !CALLER_SUPPLIED_SESSION_ID_REGEX.test(value)) {
    return { kind: "invalid" };
  }
  return { kind: "valid", sessionId: normalizeSessionIdForLookup(value) };
}
__name(parseCallerSuppliedSessionId, "parseCallerSuppliedSessionId");

export {
  isValidSessionId,
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
