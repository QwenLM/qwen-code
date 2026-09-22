// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/headlessSafetyWarnings.ts
init_esbuild_shims();
var HEADLESS_YOLO_NO_SANDBOX_WARNING = "Warning: running headless with --yolo / approval-mode=yolo and no sandbox. All tool calls (shell, write, edit) auto-execute at this process's privilege level. Enable a sandbox via --sandbox / QWEN_SANDBOX, or set QWEN_CODE_SUPPRESS_YOLO_WARNING=1 to silence this notice.";
function getHeadlessYoloSafetyWarning(config, env = process.env) {
  if (config.getApprovalMode() !== "yolo") return null;
  if (config.getSandbox()) return null;
  if (env["SANDBOX"]) return null;
  if (isTruthyEnv(env["QWEN_CODE_SUPPRESS_YOLO_WARNING"])) return null;
  return HEADLESS_YOLO_NO_SANDBOX_WARNING;
}
__name(getHeadlessYoloSafetyWarning, "getHeadlessYoloSafetyWarning");
function isTruthyEnv(val) {
  return val === "1" || val === "true";
}
__name(isTruthyEnv, "isTruthyEnv");

export {
  HEADLESS_YOLO_NO_SANDBOX_WARNING,
  getHeadlessYoloSafetyWarning
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
