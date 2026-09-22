// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/hooks/session-delete-hook.ts
init_esbuild_shims();
function fireSessionDeleteHook(config, sessionId, logger = config.getDebugLogger()) {
  void config.getHookSystem()?.fireSessionDeleteEvent(sessionId).catch((error) => {
    logger.warn(
      `SessionDelete hook failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
    );
  });
}
__name(fireSessionDeleteHook, "fireSessionDeleteHook");

export {
  fireSessionDeleteHook
};
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
