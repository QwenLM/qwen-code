// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/responses-message.ts
init_esbuild_shims();
function getResponsesMessage(part) {
  const value = part.responsesMessage;
  if (!value || typeof value.id !== "string") return void 0;
  if (value.phase !== void 0 && value.phase !== "commentary" && value.phase !== "final_answer") {
    return { id: value.id };
  }
  return value;
}
__name(getResponsesMessage, "getResponsesMessage");
function sameResponsesMessage(left, right) {
  const a = getResponsesMessage(left);
  const b = getResponsesMessage(right);
  return a?.id === b?.id && a?.phase === b?.phase;
}
__name(sameResponsesMessage, "sameResponsesMessage");

export {
  getResponsesMessage,
  sameResponsesMessage
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
