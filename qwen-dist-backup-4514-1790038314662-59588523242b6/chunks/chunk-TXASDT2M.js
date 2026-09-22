// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/load-undici.ts
init_esbuild_shims();
var undiciModulePromise;
async function loadUndici() {
  undiciModulePromise ??= import("./undici-S7WJSKGJ.js").then((mod) => {
    const keys = Object.keys(mod);
    if (keys.length === 1 && keys[0] === "default") {
      return mod.default;
    }
    return mod;
  });
  return undiciModulePromise;
}
__name(loadUndici, "loadUndici");

export {
  loadUndici
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
