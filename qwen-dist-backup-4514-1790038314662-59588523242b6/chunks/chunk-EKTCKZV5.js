// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/types.ts
init_esbuild_shims();
var GOAL_STATUS_KINDS = [
  "set",
  "achieved",
  "cleared",
  "failed",
  "aborted",
  "paused",
  "checking"
];
function isGoalStatusKind(value) {
  return typeof value === "string" && GOAL_STATUS_KINDS.includes(value);
}
__name(isGoalStatusKind, "isGoalStatusKind");
var TERMINAL_GOAL_STATUS_KINDS = [
  "achieved",
  "aborted",
  "failed"
];
function isTerminalGoalStatusKind(kind) {
  return TERMINAL_GOAL_STATUS_KINDS.includes(
    kind
  );
}
__name(isTerminalGoalStatusKind, "isTerminalGoalStatusKind");
var isHistoryItemVisibleAfterRestore = /* @__PURE__ */ __name((item) => !item.display?.suppressOnRestore, "isHistoryItemVisibleAfterRestore");

export {
  isGoalStatusKind,
  isTerminalGoalStatusKind,
  isHistoryItemVisibleAfterRestore
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
