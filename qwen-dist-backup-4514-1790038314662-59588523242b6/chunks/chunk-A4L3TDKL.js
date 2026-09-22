// Force strict mode and setup for ESM
"use strict";
import {
  runExitCleanup
} from "./chunk-FR7RJHJR.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/processUtils.ts
init_esbuild_shims();
var RELAUNCH_EXIT_CODE = 42;
var UPDATE_RELAUNCH_EXIT_CODE = 43;
var UPDATE_COMPLETE_EXIT_CODE = 44;
var SKIP_UPDATE_CHECK_ENV_VAR = "QWEN_CODE_SKIP_UPDATE_CHECK_ONCE";
var CUSTOM_SANDBOX_IMAGE_ENV_VAR = "QWEN_CODE_CUSTOM_SANDBOX_IMAGE";
var HOST_UPDATE_RELAUNCH_ENV_VAR = "QWEN_CODE_HOST_UPDATE_RELAUNCH";
var UPDATE_ON_EXIT_MESSAGE = "qwen-code:update-on-exit";
async function relaunchApp() {
  await runExitCleanup();
  process.exit(RELAUNCH_EXIT_CODE);
}
__name(relaunchApp, "relaunchApp");
async function relaunchForUpdate() {
  await runExitCleanup();
  process.exit(UPDATE_RELAUNCH_EXIT_CODE);
}
__name(relaunchForUpdate, "relaunchForUpdate");
function requestUpdateOnExit() {
  if (!process.send) return false;
  try {
    process.send({ type: UPDATE_ON_EXIT_MESSAGE });
    return true;
  } catch {
    return false;
  }
}
__name(requestUpdateOnExit, "requestUpdateOnExit");

export {
  RELAUNCH_EXIT_CODE,
  UPDATE_RELAUNCH_EXIT_CODE,
  UPDATE_COMPLETE_EXIT_CODE,
  SKIP_UPDATE_CHECK_ENV_VAR,
  CUSTOM_SANDBOX_IMAGE_ENV_VAR,
  HOST_UPDATE_RELAUNCH_ENV_VAR,
  UPDATE_ON_EXIT_MESSAGE,
  relaunchApp,
  relaunchForUpdate,
  requestUpdateOnExit
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
