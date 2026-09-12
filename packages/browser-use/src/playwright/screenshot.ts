/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { clearTimeout, setTimeout } from 'node:timers';

import type { ChromeBridge } from '../bridge/index.js';
import { BrowserRuntimeError } from '../core/errors.js';
import type { ScreenshotEnvelope } from '../core/primitives.js';
import {
  MAX_FULLPAGE_SCREENSHOT_PIXELS,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_PIXELS,
  assertScreenshotBudget,
  assertScreenshotDimensions,
} from '../core/screenshot-budget.js';
import {
  isClip,
  jpegDimensions,
  numberArg,
  record,
} from './runtime-helpers.js';
import type { Args, TabState } from './runtime-state.js';

const FRAME_TIMEOUT_MS = 2_000;
const CAPTURE_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 1_000;
const screenshotQueues = new WeakMap<TabState, Promise<unknown>>();

type SendCdp = (
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<Record<string, unknown>>;

export async function captureTabScreenshot(
  tab: TabState,
  args: Args,
  bridge: ChromeBridge,
): Promise<ScreenshotEnvelope> {
  // Chrome has one screencast per target, not one per CDP caller.
  const pending = (screenshotQueues.get(tab) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => capture(tab, args, bridge));
  screenshotQueues.set(tab, pending);
  try {
    return await pending;
  } finally {
    if (screenshotQueues.get(tab) === pending) screenshotQueues.delete(tab);
  }
}

async function capture(
  tab: TabState,
  args: Args,
  bridge: ChromeBridge,
): Promise<ScreenshotEnvelope> {
  const send: SendCdp = async (
    method,
    params = {},
    timeoutMs = CAPTURE_TIMEOUT_MS,
  ) =>
    record(
      await bridge.request(
        'cdp.send',
        { tabId: tab.providerTabId, method, params },
        timeoutMs,
      ),
    );
  // A fresh screencast timestamp can still carry pre-scroll compositor
  // pixels. Let painting catch up before measuring the page, but do not wait
  // indefinitely in background tabs, and never let a broken page world take
  // the capture down with it: the ratio is then measured from the captured
  // pixels instead.
  let probedRatio: number | undefined;
  try {
    const pixelRatio = record(
      (
        await send(
          'Runtime.evaluate',
          {
            expression: `new Promise(resolve => {
              let first = 0, second = 0;
              const timer = setTimeout(finish, 250);
              function finish() {
                clearTimeout(timer);
                cancelAnimationFrame(first);
                cancelAnimationFrame(second);
                resolve(window.devicePixelRatio);
              }
              first = requestAnimationFrame(() => {
                second = requestAnimationFrame(finish);
              });
            })`,
            awaitPromise: true,
            returnByValue: true,
          },
          FRAME_TIMEOUT_MS,
        )
      ).result,
    ).value;
    if (
      typeof pixelRatio === 'number' &&
      Number.isFinite(pixelRatio) &&
      pixelRatio > 0
    )
      probedRatio = pixelRatio;
  } catch {
    probedRatio = undefined;
  }
  let devicePixelRatio = probedRatio ?? 1;
  const layout = await send('Page.getLayoutMetrics');
  const viewport = record(layout.cssVisualViewport);
  const content = record(layout.cssContentSize);
  const viewportWidth = numberArg(viewport, 'clientWidth');
  const viewportHeight = numberArg(viewport, 'clientHeight');
  assertScreenshotDimensions(viewportWidth, viewportHeight, 'Viewport');
  const clip = isClip(args.clip) ? args.clip : undefined;
  const fullPage = args.fullPage === true;
  const constrained = fullPage || clip !== undefined;
  const width =
    clip?.width ?? (fullPage ? numberArg(content, 'width') : viewportWidth);
  const height =
    clip?.height ?? (fullPage ? numberArg(content, 'height') : viewportHeight);
  // The image's top-left pixel as a document point; only a viewport capture
  // is directly aligned with the viewport coordinate space cua consumes.
  const origin = {
    x: fullPage
      ? numberArg(content, 'x')
      : numberArg(viewport, 'pageX') + (clip?.x ?? 0),
    y: fullPage
      ? numberArg(content, 'y')
      : numberArg(viewport, 'pageY') + (clip?.y ?? 0),
  };
  if (constrained)
    assertScreenshotBudget(
      width,
      height,
      fullPage ? 'Full-page' : 'Clip',
      fullPage ? MAX_FULLPAGE_SCREENSHOT_PIXELS : MAX_SCREENSHOT_PIXELS,
    );

  let data: string | undefined;
  if (!constrained && devicePixelRatio >= 1)
    data = await viewportFrame(
      tab.providerTabId,
      bridge,
      send,
      width,
      height,
      origin,
    );
  if (data === undefined) {
    data = await captureRegion(
      send,
      constrained,
      origin,
      width,
      height,
      1 / devicePixelRatio,
    );
    if (probedRatio === undefined) {
      // The settle probe failed, so the capture above assumed a ratio of 1;
      // measure what Chrome actually produced and re-capture on HiDPI hosts
      // instead of failing the capture or shipping rescaled pixels.
      const measured = jpegDimensions(Buffer.from(data, 'base64'));
      const implied = measured.width / width;
      if (
        (Math.abs(measured.width - Math.round(width)) > 1 ||
          Math.abs(measured.height - Math.round(height)) > 1) &&
        Number.isFinite(implied) &&
        implied > 0 &&
        Math.abs(implied - 1) > 0.01
      ) {
        devicePixelRatio = implied;
        data = await captureRegion(
          send,
          constrained,
          origin,
          width,
          height,
          1 / implied,
        );
      }
    }
  }

  const buffer = Buffer.from(data, 'base64');
  const dimensions = jpegDimensions(buffer);
  // The css-pixels contract requires the capture to come back 1:1 with the
  // requested CSS region. The pixel ratio behind clip.scale is probed from
  // page script, so a page-controlled or stale ratio must not silently ship
  // a rescaled image; ±1 covers Chrome's rounding of fractional CSS sizes.
  if (
    Math.abs(dimensions.width - Math.round(width)) > 1 ||
    Math.abs(dimensions.height - Math.round(height)) > 1
  )
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome returned a screenshot that does not match the viewport; retry',
    );
  if (constrained)
    assertScreenshotBudget(
      dimensions.width,
      dimensions.height,
      'Captured',
      fullPage ? MAX_FULLPAGE_SCREENSHOT_PIXELS : MAX_SCREENSHOT_PIXELS,
    );
  else
    assertScreenshotDimensions(dimensions.width, dimensions.height, 'Captured');
  if (buffer.length > MAX_SCREENSHOT_BYTES)
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome screenshot exceeded the encoded byte budget; use a smaller clip',
    );
  return {
    base64: data,
    mimeType: 'image/jpeg',
    ...dimensions,
    viewport: { width: viewportWidth, height: viewportHeight },
    devicePixelRatio,
    coordinateSpace: 'css-pixels',
    origin,
  };
}

async function captureRegion(
  send: SendCdp,
  constrained: boolean,
  origin: { x: number; y: number },
  width: number,
  height: number,
  scale: number,
): Promise<string> {
  const result = await send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 80,
    captureBeyondViewport: constrained,
    clip: { x: origin.x, y: origin.y, width, height, scale },
  });
  if (typeof result.data !== 'string' || result.data.length === 0)
    throw new BrowserRuntimeError(
      'OPERATION_FAILED',
      'Chrome returned no screenshot data',
    );
  return result.data;
}

async function viewportFrame(
  tabId: number,
  bridge: ChromeBridge,
  send: SendCdp,
  width: number,
  height: number,
  origin: { x: number; y: number },
): Promise<string | undefined> {
  type Frame = { data: string; sessionId: number };
  let settle: (frame: Frame | undefined) => void = () => undefined;
  const nextFrame = new Promise<Frame | undefined>((resolve) => {
    settle = resolve;
  });
  const timer = setTimeout(() => settle(undefined), FRAME_TIMEOUT_MS);
  const startedAt = Date.now() / 1_000;
  const removeListener = bridge.onEvent((event) => {
    if (event.tabId !== tabId || event.sessionId !== undefined) return;
    const params = record(event.params);
    if (
      event.method === 'Page.screencastVisibilityChanged' &&
      params.visible === false
    ) {
      settle(undefined);
      return;
    }
    if (event.method !== 'Page.screencastFrame') return;
    const sessionId = params.sessionId;
    if (typeof sessionId !== 'number') return;
    const metadata = record(params.metadata);
    const timestamp = metadata.timestamp;
    const fresh =
      typeof timestamp === 'number' &&
      Number.isFinite(timestamp) &&
      timestamp >= startedAt;
    // The origin was measured before this frame existed; a frame whose
    // scroll offsets disagree with it depicts a different document region,
    // so fall back to a capture whose clip pins the published region.
    const moved =
      (typeof metadata.scrollOffsetX === 'number' &&
        Math.abs(metadata.scrollOffsetX - origin.x) > 1) ||
      (typeof metadata.scrollOffsetY === 'number' &&
        Math.abs(metadata.scrollOffsetY - origin.y) > 1);
    if (
      fresh &&
      !moved &&
      typeof params.data === 'string' &&
      params.data.length > 0
    ) {
      settle({ data: params.data, sessionId });
      return;
    }
    void send(
      'Page.screencastFrameAck',
      { sessionId },
      CLEANUP_TIMEOUT_MS,
    ).catch(() => undefined);
    if (fresh && moved) settle(undefined);
  });
  let frame: Frame | undefined;
  try {
    await send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: 80,
        everyNthFrame: 1,
        maxWidth: Math.round(width),
        maxHeight: Math.round(height),
      },
      FRAME_TIMEOUT_MS,
    );
    frame = await nextFrame;
    if (frame === undefined) return undefined;
    const dimensions = jpegDimensions(Buffer.from(frame.data, 'base64'));
    // A resized viewport or a non-default zoom must not change CUA coordinates.
    return dimensions.width === Math.round(width) &&
      dimensions.height === Math.round(height)
      ? frame.data
      : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    removeListener();
    settle(undefined);
    await send('Page.stopScreencast', {}, CLEANUP_TIMEOUT_MS).catch(
      () => undefined,
    );
    if (frame !== undefined)
      await send(
        'Page.screencastFrameAck',
        { sessionId: frame.sessionId },
        CLEANUP_TIMEOUT_MS,
      ).catch(() => undefined);
  }
}
