// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";

// packages/core/src/config/approval-mode.ts
init_esbuild_shims();
var ApprovalMode = /* @__PURE__ */ ((ApprovalMode2) => {
  ApprovalMode2["PLAN"] = "plan";
  ApprovalMode2["DEFAULT"] = "default";
  ApprovalMode2["AUTO_EDIT"] = "auto-edit";
  ApprovalMode2["AUTO"] = "auto";
  ApprovalMode2["YOLO"] = "yolo";
  return ApprovalMode2;
})(ApprovalMode || {});
var APPROVAL_MODES = Object.values(ApprovalMode);

export {
  APPROVAL_MODES
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
