// Force strict mode and setup for ESM
"use strict";
import {
  expandHomeDir
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/resolvePath.ts
init_esbuild_shims();
function resolvePath(p) {
  return expandHomeDir(p);
}
__name(resolvePath, "resolvePath");

export {
  resolvePath
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
