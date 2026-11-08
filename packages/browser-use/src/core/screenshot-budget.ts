/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRuntimeError } from './errors.js';

// Keep the worst-case RGBA payload below the MCP/bridge byte ceilings while
// still allowing a full 1920x1080 viewport without changing the 1:1 CSS-pixel
// coordinate contract. Viewport captures keep the whole window for the
// coordinate contract, so their size is bounded by MAX_SCREENSHOT_BYTES
// instead. Clips are caller-sized and keep the single-viewport pixel budget;
// full-page captures follow the page's content height, so they get a larger
// budget bounded by the edge cap — the encoded byte check below stays the
// real post-capture guard.
export const MAX_SCREENSHOT_PIXELS = 2_097_152;
export const MAX_SCREENSHOT_EDGE = 8_192;
export const MAX_FULLPAGE_SCREENSHOT_PIXELS = 16_777_216;
// nodeRepl.emitImage() rejects images above 4 MiB (MAX_MODEL_IMAGE_BYTES in
// node-repl), so a larger capture would pass here and be dropped at the
// model boundary with no recovery lever.
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

export function assertScreenshotDimensions(
  width: number,
  height: number,
  context: string,
): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      `Chrome returned invalid ${context} screenshot dimensions`,
    );
  }
}

export function assertScreenshotBudget(
  width: number,
  height: number,
  context: string,
  maxPixels = MAX_SCREENSHOT_PIXELS,
): void {
  assertScreenshotDimensions(width, height, context);
  if (
    width > MAX_SCREENSHOT_EDGE ||
    height > MAX_SCREENSHOT_EDGE ||
    width * height > maxPixels
  ) {
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `${context} screenshot dimensions ${Math.ceil(width)}x${Math.ceil(height)} exceed the ` +
        `${maxPixels}-pixel capture budget; use a smaller viewport or clip`,
      {
        width,
        height,
        maxPixels,
        maxEdge: MAX_SCREENSHOT_EDGE,
      },
    );
  }
}
