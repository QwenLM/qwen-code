/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Buffer } from 'node:buffer';

import type { Page } from 'playwright-core';

import { BrowserRuntimeError } from '../core/errors.js';
import type { ScreenshotEnvelope } from '../core/primitives.js';
import {
  assertScreenshotBudget,
  assertScreenshotDimensions,
  MAX_SCREENSHOT_BYTES,
} from '../core/screenshot-budget.js';
import { isClip, pngDimensions } from './runtime-helpers.js';
import type { Args, ScreenshotMetrics, TabState } from './runtime-state.js';

export async function captureTabScreenshot(
  tab: TabState,
  args: Args,
): Promise<ScreenshotEnvelope> {
  const metrics = await screenshotMetrics(tab.page);
  const clip = isClip(args.clip) ? args.clip : undefined;
  const width =
    clip?.width ??
    (args.fullPage === true ? metrics.contentWidth : metrics.width);
  const height =
    clip?.height ??
    (args.fullPage === true ? metrics.contentHeight : metrics.height);
  const constrained = args.fullPage === true || clip !== undefined;
  const context = args.fullPage === true ? 'Full-page' : 'Viewport';
  if (constrained) assertScreenshotBudget(width, height, context);
  else assertScreenshotDimensions(width, height, context);
  const buffer = await tab.page.screenshot({
    type: 'png',
    scale: 'css',
    ...(args.fullPage === true ? { fullPage: true } : {}),
    ...(clip === undefined ? {} : { clip }),
  });
  return screenshotEnvelope(buffer, constrained);
}

function screenshotEnvelope(
  buffer: Buffer,
  constrained: boolean,
): ScreenshotEnvelope {
  const dimensions = pngDimensions(buffer);
  if (constrained)
    assertScreenshotBudget(dimensions.width, dimensions.height, 'Captured');
  else
    assertScreenshotDimensions(dimensions.width, dimensions.height, 'Captured');
  if (buffer.length > MAX_SCREENSHOT_BYTES)
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome screenshot exceeded the encoded byte budget; use a smaller clip',
    );
  return {
    base64: buffer.toString('base64'),
  };
}

async function screenshotMetrics(page: Page): Promise<ScreenshotMetrics> {
  return await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      width: innerWidth,
      height: innerHeight,
      contentWidth: Math.max(
        root.scrollWidth,
        root.offsetWidth,
        body?.scrollWidth ?? 0,
        body?.offsetWidth ?? 0,
      ),
      contentHeight: Math.max(
        root.scrollHeight,
        root.offsetHeight,
        body?.scrollHeight ?? 0,
        body?.offsetHeight ?? 0,
      ),
    };
  });
}
