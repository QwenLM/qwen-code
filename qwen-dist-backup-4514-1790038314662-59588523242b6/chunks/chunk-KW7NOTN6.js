// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/housekeeping/lastInteractionAt.ts
init_esbuild_shims();
var lastInteractionAt = Date.now();
function noteInteraction() {
  lastInteractionAt = Date.now();
}
__name(noteInteraction, "noteInteraction");
function msSinceLastInteraction() {
  return Date.now() - lastInteractionAt;
}
__name(msSinceLastInteraction, "msSinceLastInteraction");

export {
  noteInteraction,
  msSinceLastInteraction
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
