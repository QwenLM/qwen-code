// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/omni/smart-resize.ts
init_esbuild_shims();
var OMNI_PATCH_GRID_FACTOR = 28;
var IMAGE_TOKEN_BUDGET_TIERS = {
  small: 256,
  normal: 1024,
  large: 2048
};
var VIDEO_FRAME_TOKEN_BUDGET_TIERS = {
  small: 80,
  normal: 256,
  large: 1024
};
function pixelsPerToken(factor = OMNI_PATCH_GRID_FACTOR) {
  return factor * factor;
}
__name(pixelsPerToken, "pixelsPerToken");
function tokenBudgetToPixels(tier, tiers, factor = OMNI_PATCH_GRID_FACTOR) {
  const tokens = tiers[tier] ?? tiers.normal;
  return tokens * pixelsPerToken(factor);
}
__name(tokenBudgetToPixels, "tokenBudgetToPixels");
function smartResize(width, height, options = {}) {
  const factor = options.factor ?? OMNI_PATCH_GRID_FACTOR;
  const minPixels = options.minPixels ?? 0;
  let maxPixels = options.maxPixels ?? Number.POSITIVE_INFINITY;
  if (minPixels > maxPixels) {
    maxPixels = minPixels;
  }
  let w = width;
  let h = height;
  const pixels = w * h;
  if (pixels < minPixels) {
    const scale = Math.sqrt(minPixels / pixels);
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }
  if (w * h > maxPixels) {
    const scale = Math.sqrt(maxPixels / (w * h));
    w = Math.floor(w * scale);
    h = Math.floor(h * scale);
  }
  w = Math.max(factor, Math.round(w / factor) * factor);
  h = Math.max(factor, Math.round(h / factor) * factor);
  const aspectRatio = width / height;
  while (w * h > maxPixels && (w > factor || h > factor)) {
    if (w === factor) {
      h -= factor;
      continue;
    }
    if (h === factor) {
      w -= factor;
      continue;
    }
    const widthError = Math.abs((w - factor) / h / aspectRatio - 1);
    const heightError = Math.abs(w / (h - factor) / aspectRatio - 1);
    if (widthError <= heightError) {
      w -= factor;
    } else {
      h -= factor;
    }
  }
  return { width: w, height: h };
}
__name(smartResize, "smartResize");
function imageDimensionsForTokenBudget(width, height, tier) {
  const budgetPixels = tokenBudgetToPixels(tier, IMAGE_TOKEN_BUDGET_TIERS);
  const minPixels = tokenBudgetToPixels("small", IMAGE_TOKEN_BUDGET_TIERS);
  return {
    ...smartResize(width, height, { minPixels, maxPixels: budgetPixels }),
    budgetPixels
  };
}
__name(imageDimensionsForTokenBudget, "imageDimensionsForTokenBudget");
function videoFrameDimensionsForTokenBudget(width, height, tier) {
  const budgetPixels = tokenBudgetToPixels(
    tier,
    VIDEO_FRAME_TOKEN_BUDGET_TIERS
  );
  const minPixels = tokenBudgetToPixels(
    "small",
    VIDEO_FRAME_TOKEN_BUDGET_TIERS
  );
  return {
    ...smartResize(width, height, { minPixels, maxPixels: budgetPixels }),
    budgetPixels
  };
}
__name(videoFrameDimensionsForTokenBudget, "videoFrameDimensionsForTokenBudget");

export {
  imageDimensionsForTokenBudget,
  videoFrameDimensionsForTokenBudget
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
