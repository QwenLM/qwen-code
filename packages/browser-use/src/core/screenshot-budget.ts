/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRuntimeError } from './errors.js';

// Keep the worst-case RGBA payload below the MCP/bridge byte ceilings while
// still allowing a full 1920x1080 viewport without changing the 1:1 CSS-pixel
// coordinate contract.
export const MAX_SCREENSHOT_PIXELS = 2_097_152;
export const MAX_SCREENSHOT_EDGE = 8_192;
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

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
): void {
  assertScreenshotDimensions(width, height, context);
  if (
    width > MAX_SCREENSHOT_EDGE ||
    height > MAX_SCREENSHOT_EDGE ||
    width * height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new BrowserRuntimeError(
      'INVALID_ARGUMENT',
      `${context} screenshot dimensions ${Math.ceil(width)}x${Math.ceil(height)} exceed the ` +
        `${MAX_SCREENSHOT_PIXELS}-pixel capture budget; use a smaller viewport or clip`,
      {
        width,
        height,
        maxPixels: MAX_SCREENSHOT_PIXELS,
        maxEdge: MAX_SCREENSHOT_EDGE,
      },
    );
  }
}
