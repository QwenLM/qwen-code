// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/bundlePaths.ts
init_esbuild_shims();
import * as path from "node:path";
import { fileURLToPath } from "node:url";
var BUNDLE_CHUNK_DIR = "chunks";
function resolveBundleDir(importMetaUrl) {
  const moduleDir = path.dirname(fileURLToPath(importMetaUrl));
  return path.basename(moduleDir) === BUNDLE_CHUNK_DIR ? path.dirname(moduleDir) : moduleDir;
}
__name(resolveBundleDir, "resolveBundleDir");

export {
  resolveBundleDir
};
/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */
