// Force strict mode and setup for ESM
"use strict";
import {
  __esm
} from "./chunk-J2S4EL5Y.js";

// scripts/esbuild-shims.js
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
var _require, __qwen_filename, __qwen_dirname;
var init_esbuild_shims = __esm({
  "scripts/esbuild-shims.js"() {
    "use strict";
    _require = createRequire(import.meta.url);
    if (typeof globalThis.require === "undefined") {
      globalThis.require = _require;
    }
    __qwen_filename = fileURLToPath(import.meta.url);
    __qwen_dirname = dirname(__qwen_filename);
  }
});

export {
  __qwen_filename,
  __qwen_dirname,
  init_esbuild_shims
};
/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
