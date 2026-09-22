// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/externalToolGuard.ts
init_esbuild_shims();
var PRIVATE_EXTERNAL_TOOL_GUARD_ENV = "QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD";
var PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV = "QWEN_CODE_PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER";
var EXTERNAL_TOOL_GUARD_READY_META_KEY = "qwen-code/external-tool-guard-ready";
var EXTERNAL_TOOL_GUARD_REQUIRED_VALUE = "required-v1";
var EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE = "attached-v1";
var SHELL_EXECUTING_TOOL_NAMES = /* @__PURE__ */ new Set([
  "monitor",
  "run_shell_command"
]);
var EXTERNAL_TOOL_GUARD_TOKEN_ENV = "QWEN_CODE_EXTERNAL_TOOL_GUARD_TOKEN";
var EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS = 500;
function containsUnsafeExternalToolGuardControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code >= 127 && code <= 159 || code === 8232 || code === 8233;
  });
}
__name(containsUnsafeExternalToolGuardControlCharacter, "containsUnsafeExternalToolGuardControlCharacter");
function isValidExternalToolGuardDenialReason(reason) {
  return typeof reason === "string" && reason.trim().length > 0 && reason.length <= EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS && !containsUnsafeExternalToolGuardControlCharacter(reason);
}
__name(isValidExternalToolGuardDenialReason, "isValidExternalToolGuardDenialReason");

export {
  PRIVATE_EXTERNAL_TOOL_GUARD_ENV,
  PRIVATE_EXTERNAL_TOOL_GUARD_PROVIDER_ENV,
  EXTERNAL_TOOL_GUARD_READY_META_KEY,
  EXTERNAL_TOOL_GUARD_REQUIRED_VALUE,
  EXTERNAL_TOOL_GUARD_PROVIDER_ATTACHED_VALUE,
  SHELL_EXECUTING_TOOL_NAMES,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  EXTERNAL_TOOL_GUARD_MAX_DENIAL_REASON_CHARS,
  containsUnsafeExternalToolGuardControlCharacter,
  isValidExternalToolGuardDenialReason
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
