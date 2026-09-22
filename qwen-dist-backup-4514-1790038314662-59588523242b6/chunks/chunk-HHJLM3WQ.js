// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/safeJsonStringify.ts
init_esbuild_shims();
function safeJsonStringify(obj, space) {
  const ancestors = [];
  return JSON.stringify(
    obj,
    function(_key, value) {
      if (typeof value !== "object" || value === null) {
        return value;
      }
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
        ancestors.pop();
      }
      if (ancestors.includes(value)) {
        return "[Circular]";
      }
      ancestors.push(value);
      return value;
    },
    space
  );
}
__name(safeJsonStringify, "safeJsonStringify");

export {
  safeJsonStringify
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
