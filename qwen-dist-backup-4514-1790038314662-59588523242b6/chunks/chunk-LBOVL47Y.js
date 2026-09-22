// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/runtime/cpu-percent.ts
init_esbuild_shims();
function computeCpuPercent(prev, cur, elapsedMs, coreCount) {
  if (!prev || !cur || elapsedMs <= 0 || coreCount <= 0) return 0;
  const cpuUs = cur.user - prev.user + (cur.system - prev.system);
  return Math.min(
    100,
    Math.max(0, cpuUs / (elapsedMs * 1e3) * 100 / coreCount)
  );
}
__name(computeCpuPercent, "computeCpuPercent");

export {
  computeCpuPercent
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
