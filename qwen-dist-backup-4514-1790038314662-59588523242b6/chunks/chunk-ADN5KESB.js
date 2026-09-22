// Force strict mode and setup for ESM
"use strict";
import {
  isTruthy
} from "./chunk-SK3RZOPS.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/safe-mode.ts
init_esbuild_shims();
var SAFE_MODE_ENV_VAR = "QWEN_CODE_SAFE_MODE";
function isSafeModeEnv() {
  return isTruthy(process.env[SAFE_MODE_ENV_VAR]);
}
__name(isSafeModeEnv, "isSafeModeEnv");

export {
  isSafeModeEnv
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
