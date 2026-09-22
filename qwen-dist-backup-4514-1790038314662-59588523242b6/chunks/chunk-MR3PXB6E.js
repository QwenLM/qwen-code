// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/config/path-comparison.ts
init_esbuild_shims();
import * as fs from "node:fs";
import * as path from "node:path";
function isWithinRoot(childPath, parentPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || !relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath);
}
__name(isWithinRoot, "isWithinRoot");
function getPathComparisonVariants(rawPath) {
  const variants = /* @__PURE__ */ new Set([path.normalize(path.resolve(rawPath))]);
  try {
    variants.add(path.normalize(fs.realpathSync(rawPath)));
  } catch {
  }
  return variants;
}
__name(getPathComparisonVariants, "getPathComparisonVariants");
function arePathsEquivalent(left, right) {
  const rightVariants = getPathComparisonVariants(right);
  for (const leftVariant of getPathComparisonVariants(left)) {
    if (rightVariants.has(leftVariant)) {
      return true;
    }
  }
  return false;
}
__name(arePathsEquivalent, "arePathsEquivalent");

export {
  isWithinRoot,
  getPathComparisonVariants,
  arePathsEquivalent
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
