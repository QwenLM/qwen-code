// Force strict mode and setup for ESM
"use strict";
import {
  getEffectiveOmniUploadConfig
} from "./chunk-SATGWSS6.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/delivery-gate.ts
init_esbuild_shims();
var debugLogger = createDebugLogger("omni:delivery-gate");
function isOmniDeliveryActive(config) {
  if (!config.isOmniEnabled?.()) return false;
  if (config.isTrustedFolder?.() === false) {
    debugLogger.debug("omni delivery inactive: untrusted workspace");
    return false;
  }
  if (!getEffectiveOmniUploadConfig(config)) {
    debugLogger.debug(
      "omni delivery inactive: no usable DashScope upload configuration"
    );
    return false;
  }
  return true;
}
__name(isOmniDeliveryActive, "isOmniDeliveryActive");

export {
  isOmniDeliveryActive
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
