// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/policy/tools/sharp-module.ts
init_esbuild_shims();
async function loadSharp() {
  return (await import("sharp")).default;
}
__name(loadSharp, "loadSharp");

export {
  loadSharp
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
