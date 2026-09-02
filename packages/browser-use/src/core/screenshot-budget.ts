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
export const MAX_SCREENSHOT_BASE64_CHARS = 14 * 1024 * 1024;

export function assertScreenshotBudget(
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

export function screenshotBytesWithinBudget(base64: string): boolean {
  if (
    base64.length === 0 ||
    base64.length > MAX_SCREENSHOT_BASE64_CHARS ||
    base64.length % 4 !== 0
  )
    return false;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding <= MAX_SCREENSHOT_BYTES;
}
