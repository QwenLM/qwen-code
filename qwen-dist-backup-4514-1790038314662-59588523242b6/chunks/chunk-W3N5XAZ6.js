// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/utils/package.ts
init_esbuild_shims();
import { fileURLToPath } from "node:url";
import path from "node:path";
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var packageJson;
async function getPackageJson() {
  if (packageJson) {
    return packageJson;
  }
  const { readPackageUp } = await import("./read-package-up-6T6ICKR7.js");
  const result = await readPackageUp({ cwd: __dirname });
  if (!result) {
    return;
  }
  packageJson = result.packageJson;
  return packageJson;
}
__name(getPackageJson, "getPackageJson");

export {
  getPackageJson
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
