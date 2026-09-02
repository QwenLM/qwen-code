/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRuntimeError } from './errors.js';
import type { ScreenshotEnvelope } from './primitives.js';
import {
  assertScreenshotBudget,
  screenshotBytesWithinBudget,
} from './screenshot-budget.js';
import {
  finiteNumber,
  objectValue,
  pngDimensions,
} from './chrome-runtime-values.js';

interface ViewportMetrics {
  devicePixelRatio: number;
  width: number;
  height: number;
}

export interface ScreenshotDependencies<Tab> {
  cdp(
    tab: Tab,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  readViewport(tab: Tab): Promise<unknown>;
}

export async function captureScreenshot<Tab>(
  tab: Tab,
  args: Record<string, unknown>,
  dependencies: ScreenshotDependencies<Tab>,
): Promise<ScreenshotEnvelope> {
  const viewport = await viewportMetrics(tab, dependencies);
  const metrics = objectValue(
    await dependencies.cdp(tab, 'Page.getLayoutMetrics', {}),
  );
  const visual = objectValue(
    metrics.cssVisualViewport ?? metrics.visualViewport,
  );
  const pageX = finiteNumber(visual.pageX, 0);
  const pageY = finiteNumber(visual.pageY, 0);
  const clientWidth = finiteNumber(visual.clientWidth, viewport.width);
  const clientHeight = finiteNumber(visual.clientHeight, viewport.height);
  // Optional render magnification keeps the CSS-pixel coordinate contract:
  // the clip is still expressed in CSS pixels, only the output is larger.
  const magnification =
    typeof args.scale === 'number' &&
    Number.isFinite(args.scale) &&
    args.scale >= 1
      ? args.scale
      : 1;
  const scale = magnification / viewport.devicePixelRatio;

  let clip: Record<string, number>;
  let captureBeyondViewport = false;
  if (args.fullPage === true) {
    const content = objectValue(metrics.cssContentSize ?? metrics.contentSize);
    const width = finiteNumber(content.width, 0);
    const height = finiteNumber(content.height, 0);
    assertScreenshotBudget(width, height, 'Full-page');
    clip = { x: 0, y: 0, width, height, scale };
    captureBeyondViewport = true;
  } else if (args.clip !== undefined) {
    const requested = objectValue(args.clip);
    clip = {
      x: pageX + finiteNumber(requested.x, 0),
      y: pageY + finiteNumber(requested.y, 0),
      width: finiteNumber(requested.width, clientWidth),
      height: finiteNumber(requested.height, clientHeight),
      scale,
    };
  } else {
    clip = {
      x: pageX,
      y: pageY,
      width: clientWidth,
      height: clientHeight,
      scale,
    };
  }

  assertScreenshotBudget(
    finiteNumber(clip.width, 0) * magnification,
    finiteNumber(clip.height, 0) * magnification,
    args.fullPage === true ? 'Full-page' : 'Viewport',
  );

  const result = objectValue(
    await dependencies.cdp(tab, 'Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport,
      clip,
    }),
  );
  if (typeof result.data !== 'string' || result.data === '') {
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome returned no screenshot data',
    );
  }
  if (!screenshotBytesWithinBudget(result.data)) {
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome screenshot exceeded the encoded byte budget',
    );
  }
  const dimensions = pngDimensions(result.data);
  return {
    kind: 'image',
    mediaType: 'image/png',
    base64: result.data,
    ...(dimensions ?? {}),
    viewport: { width: clientWidth, height: clientHeight },
    devicePixelRatio: viewport.devicePixelRatio,
    coordinateSpace: 'css-pixels',
  };
}

async function viewportMetrics<Tab>(
  tab: Tab,
  dependencies: ScreenshotDependencies<Tab>,
): Promise<ViewportMetrics> {
  const value = objectValue(await dependencies.readViewport(tab));
  const devicePixelRatio = finiteNumber(value.devicePixelRatio, 1);
  return {
    devicePixelRatio: devicePixelRatio > 0 ? devicePixelRatio : 1,
    width: finiteNumber(value.width, 0),
    height: finiteNumber(value.height, 0),
  };
}
