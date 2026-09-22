// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/workspace-runtime-visibility.ts
init_esbuild_shims();
function isInternalWorkspaceRuntime(runtime) {
  return runtime.provenance === "live-conversation";
}
__name(isInternalWorkspaceRuntime, "isInternalWorkspaceRuntime");

export {
  isInternalWorkspaceRuntime
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
