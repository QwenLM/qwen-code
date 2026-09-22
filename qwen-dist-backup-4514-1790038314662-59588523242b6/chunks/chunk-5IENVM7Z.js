// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/normalize-part-list.ts
init_esbuild_shims();
function normalizePartList(parts) {
  if (!parts) {
    return [];
  }
  if (typeof parts === "string") {
    return [{ text: parts }];
  }
  if (Array.isArray(parts)) {
    return parts.map(
      (part) => typeof part === "string" ? { text: part } : part
    );
  }
  return [parts];
}
__name(normalizePartList, "normalizePartList");

export {
  normalizePartList
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
