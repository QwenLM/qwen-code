// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/bareMode.ts
init_esbuild_shims();
var QWEN_CODE_SIMPLE_ENV_VAR = "QWEN_CODE_SIMPLE";
function isTruthy(value) {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase().trim());
}
__name(isTruthy, "isTruthy");
function isBareMode(cliFlag) {
  return cliFlag === true || isTruthy(process.env[QWEN_CODE_SIMPLE_ENV_VAR]);
}
__name(isBareMode, "isBareMode");

export {
  QWEN_CODE_SIMPLE_ENV_VAR,
  isTruthy,
  isBareMode
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
