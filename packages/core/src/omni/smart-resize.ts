/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Patch-grid-aligned resize math and token-budget tiers for omni visual
 * inputs (ported from Qwen-MM-Plugins `shared/image.py`:
 * `smart_resize` / `budget_to_pixels`).
 *
 * Two ideas:
 *
 * 1. **Patch-grid alignment** — the VL encoder consumes images in
 *    fixed-size patches, so a resized image whose dimensions are not a
 *    multiple of the grid wastes (or silently pads) the ragged edge.
 *    `smartResize` snaps both dimensions to a multiple of the grid
 *    factor while keeping the pixel count inside [minPixels, maxPixels]
 *    and the aspect ratio as close to the original as the grid allows.
 *
 * 2. **Token-budget tiers** — policies can speak in billing tokens
 *    instead of pixels: a tier maps to a token count, a token covers
 *    `factor²` pixels, so the tier becomes a maxPixels budget. This is
 *    the lever the degradation ladder was missing (omni 实测: 480p/10fps
 *    降不了计费 token — the metered unit is pixels×frames, and only a
 *    pixel budget addresses it). The estimator side of the same story
 *    lives in `estimation.ts` (raw-resource-v1), whose conservative
 *    2048 px/token bound deliberately differs from this module's
 *    factor² px/token — estimation over-guesses cost to stay safe,
 *    budgeting targets an exact metered grid.
 */

/** Model patch grid: one visual token covers a factor×factor pixel cell
 * (Qwen-VL family: 14px patch × 2×2 merge = 28). */
export const OMNI_PATCH_GRID_FACTOR = 28;

/** Image token budgets per tier (design/插件惯例: 256/1024/2048). */
export const IMAGE_TOKEN_BUDGET_TIERS = {
  small: 256,
  normal: 1024,
  large: 2048,
} as const;

/** Per-FRAME token budgets for video frame extraction (80/256/1024). */
export const VIDEO_FRAME_TOKEN_BUDGET_TIERS = {
  small: 80,
  normal: 256,
  large: 1024,
} as const;

export type TokenBudgetTier = 'small' | 'normal' | 'large';

/** Pixels one token covers at the given patch-grid factor. */
export function pixelsPerToken(
  factor: number = OMNI_PATCH_GRID_FACTOR,
): number {
  return factor * factor;
}

/** Map a budget tier to its pixel budget (`tokens × factor²`), the
 * plugin's `budget_to_pixels`. Unknown tiers fall back to 'normal'. */
export function tokenBudgetToPixels(
  tier: TokenBudgetTier,
  tiers: Record<TokenBudgetTier, number>,
  factor: number = OMNI_PATCH_GRID_FACTOR,
): number {
  const tokens = tiers[tier] ?? tiers.normal;
  return tokens * pixelsPerToken(factor);
}

export interface SmartResizeOptions {
  /** Lower pixel-count bound (small inputs are UPSAMPLED to it). */
  minPixels?: number;
  /** Upper pixel-count bound. */
  maxPixels?: number;
  /** Patch-grid factor both dimensions snap to. */
  factor?: number;
}

/**
 * Resize (width, height) into [minPixels, maxPixels] total pixel count,
 * snapped to multiples of the patch-grid factor. Pure function — the
 * caller applies the result with sharp/ffmpeg.
 *
 * Mirrors the plugin's `smart_resize`: upscale first when below
 * minPixels, downscale when above maxPixels, then snap both dimensions
 * to the grid (never below one cell). If grid rounding crosses maxPixels,
 * shrink one cell at a time while preserving the closest aspect ratio.
 */
export function smartResize(
  width: number,
  height: number,
  options: SmartResizeOptions = {},
): { width: number; height: number } {
  const factor = options.factor ?? OMNI_PATCH_GRID_FACTOR;
  const minPixels = options.minPixels ?? 0;
  let maxPixels = options.maxPixels ?? Number.POSITIVE_INFINITY;
  if (minPixels > maxPixels) {
    // Degenerate configuration: clamp rather than oscillate.
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

/**
 * Target dimensions for an image under a token-budget tier: the tier's
 * pixel budget as maxPixels, the SMALLEST tier's budget as minPixels
 * (the plugin's IMAGE_MIN_PIXELS convention — tiny images are upsampled
 * onto the grid instead of billing a fraction of a cell), snapped to
 * the grid.
 */
export function imageDimensionsForTokenBudget(
  width: number,
  height: number,
  tier: TokenBudgetTier,
): { width: number; height: number; budgetPixels: number } {
  const budgetPixels = tokenBudgetToPixels(tier, IMAGE_TOKEN_BUDGET_TIERS);
  const minPixels = tokenBudgetToPixels('small', IMAGE_TOKEN_BUDGET_TIERS);
  return {
    ...smartResize(width, height, { minPixels, maxPixels: budgetPixels }),
    budgetPixels,
  };
}

/** Per-frame target dimensions for a video frame under a token-budget
 * tier (same convention as {@link imageDimensionsForTokenBudget} with
 * the video tiers). */
export function videoFrameDimensionsForTokenBudget(
  width: number,
  height: number,
  tier: TokenBudgetTier,
): { width: number; height: number; budgetPixels: number } {
  const budgetPixels = tokenBudgetToPixels(
    tier,
    VIDEO_FRAME_TOKEN_BUDGET_TIERS,
  );
  const minPixels = tokenBudgetToPixels(
    'small',
    VIDEO_FRAME_TOKEN_BUDGET_TIERS,
  );
  return {
    ...smartResize(width, height, { minPixels, maxPixels: budgetPixels }),
    budgetPixels,
  };
}
