// Force strict mode and setup for ESM
"use strict";
import {
  getPackageJson
} from "./chunk-W3N5XAZ6.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/version.ts
init_esbuild_shims();
async function getCliVersion() {
  const pkgJson = await getPackageJson();
  return "0.24.0";
}
__name(getCliVersion, "getCliVersion");
function formatVersionLabel(version) {
  return /^\d/.test(version) ? `v${version}` : version;
}
__name(formatVersionLabel, "formatVersionLabel");

export {
  getCliVersion,
  formatVersionLabel
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
