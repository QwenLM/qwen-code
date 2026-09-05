/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'node:buffer';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import type {
  BridgeEvent,
  BridgeEventListener,
  ChromeBridge,
} from '../bridge/index.js';
import { jpegDimensions } from './runtime-helpers.js';
import type { TabState } from './runtime-state.js';
import { captureTabScreenshot } from './screenshot.js';

class ScreenshotBridge implements ChromeBridge {
  listeners = new Set<BridgeEventListener>();
  viewport = { clientWidth: 800, clientHeight: 600, pageX: 0, pageY: 0 };
  content = { x: 0, y: 0, width: 800, height: 1200 };
  pixelRatio = 2;
  captureData = jpeg(800, 600).toString('base64');
  onStart: () => void | Promise<void> = () => this.frame();
  onCapture: () => void | Promise<void> = () => undefined;
  onStop: () => void | Promise<void> = () => undefined;
  async start() {}
  async stop() {}
  isConnected() {
    return true;
  }
  onConnectionChange() {
    return () => undefined;
  }
  onEvent(listener: BridgeEventListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  request = vi.fn(
    async (
      _method: string,
      args: Record<string, unknown> = {},
      _timeoutMs?: number,
    ): Promise<unknown> => {
      switch (args.method) {
        case 'Page.getLayoutMetrics':
          return {
            cssVisualViewport: this.viewport,
            cssContentSize: this.content,
          };
        case 'Runtime.evaluate':
          return { result: { value: this.pixelRatio } };
        case 'Page.startScreencast':
          await this.onStart();
          return {};
        case 'Page.stopScreencast':
          await this.onStop();
          return {};
        case 'Page.captureScreenshot':
          await this.onCapture();
          return { data: this.captureData };
        default:
          return {};
      }
    },
  );
  emit(event: BridgeEvent) {
    for (const listener of this.listeners) listener(event);
  }
  frame(
    params: Record<string, unknown> = {},
    source: Partial<BridgeEvent> = {},
  ) {
    this.emit({
      type: 'event',
      tabId: 17,
      method: 'Page.screencastFrame',
      ...source,
      params: {
        sessionId: 1,
        metadata: { timestamp: Date.now() / 1000 },
        data: jpeg(
          this.viewport.clientWidth,
          this.viewport.clientHeight,
        ).toString('base64'),
        ...params,
      },
    });
  }
  methods() {
    return this.request.mock.calls.map(([, args]) => args?.method);
  }
}

function tab(): TabState {
  // Screenshot acquisition needs only the owned provider target, not a Page.
  return { providerTabId: 17 } as TabState;
}

function jpeg(width: number, height: number): Buffer {
  const bytes = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9,
  ]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

describe('Chrome screenshot acquisition', () => {
  it.each(['paint', 'timeout'])(
    'bounds rendering synchronization via %s',
    async (completion) => {
      const bridge = new ScreenshotBridge();
      await captureTabScreenshot(tab(), {}, bridge);
      const args = bridge.request.mock.calls.find(
        ([, args]) => args?.method === 'Runtime.evaluate',
      )?.[1]?.params as { expression: string; awaitPromise: boolean };
      const frames = new Map<number, () => void>();
      let nextId = 0;
      let timeout: () => void = () => undefined;
      const clearTimer = vi.fn();
      const pending: Promise<number> = runInNewContext(args.expression, {
        window: { devicePixelRatio: 2 },
        requestAnimationFrame: (callback: () => void) => {
          frames.set(++nextId, callback);
          return nextId;
        },
        cancelAnimationFrame: (id: number) => frames.delete(id),
        setTimeout: (callback: () => void, ms: number) => {
          expect(ms).toBe(250);
          timeout = callback;
          return 7;
        },
        clearTimeout: clearTimer,
      });
      const resolved = vi.fn();
      void pending.then(resolved);
      if (completion === 'paint') {
        frames.get(1)?.();
        await Promise.resolve();
        expect(resolved).not.toHaveBeenCalled();
        frames.get(2)?.();
      } else timeout();
      await expect(pending).resolves.toBe(2);
      expect(args.awaitPromise).toBe(true);
      expect(frames.size).toBe(0);
      expect(clearTimer).toHaveBeenCalledWith(7);
    },
  );

  it('returns a fresh screencast frame without a capture or Playwright font wait', async () => {
    const bridge = new ScreenshotBridge();
    const image = await captureTabScreenshot(tab(), {}, bridge);
    expect(image).toEqual({
      base64: jpeg(800, 600).toString('base64'),
      mimeType: 'image/jpeg',
      width: 800,
      height: 600,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
      coordinateSpace: 'css-pixels',
    });
    expect(bridge.methods()).toEqual([
      'Page.getLayoutMetrics',
      'Runtime.evaluate',
      'Page.startScreencast',
      'Page.stopScreencast',
      'Page.screencastFrameAck',
    ]);
    expect(bridge.request).toHaveBeenCalledWith(
      'cdp.send',
      {
        tabId: 17,
        method: 'Page.startScreencast',
        params: {
          format: 'jpeg',
          quality: 80,
          everyNthFrame: 1,
          maxWidth: 800,
          maxHeight: 600,
        },
      },
      2_000,
    );
    expect(bridge.listeners.size).toBe(0);
  });

  it('ignores other targets and acknowledges old frames before accepting a new frame', async () => {
    const bridge = new ScreenshotBridge();
    bridge.onStart = () => {
      bridge.frame({ data: 'wrong tab' }, { tabId: 18 });
      bridge.frame({ data: 'wrong session' }, { sessionId: 'child' });
      bridge.frame({
        sessionId: 2,
        metadata: { timestamp: Date.now() / 1000 - 10 },
        data: 'old',
      });
      bridge.frame({ sessionId: 3 });
    };
    const image = await captureTabScreenshot(tab(), {}, bridge);
    expect(image.base64).toBe(jpeg(800, 600).toString('base64'));
    expect(
      bridge.request.mock.calls
        .filter(([, args]) => args?.method === 'Page.screencastFrameAck')
        .map(([, args]) => args?.params),
    ).toEqual([{ sessionId: 2 }, { sessionId: 3 }]);
  });

  it('stops an idle screencast after two seconds, then uses bounded capture', async () => {
    const bridge = new ScreenshotBridge();
    bridge.onStart = () => undefined;
    const startedAt = performance.now();
    const pending = captureTabScreenshot(tab(), {}, bridge);
    await vi.waitFor(() =>
      expect(bridge.methods()).toContain('Page.startScreencast'),
    );
    expect(bridge.methods()).not.toContain('Page.captureScreenshot');
    await expect(pending).resolves.toMatchObject({ mimeType: 'image/jpeg' });
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(1_900);
    expect(bridge.methods().slice(-2)).toEqual([
      'Page.stopScreencast',
      'Page.captureScreenshot',
    ]);
    expect(bridge.request).toHaveBeenCalledWith(
      'cdp.send',
      {
        tabId: 17,
        method: 'Page.captureScreenshot',
        params: {
          format: 'jpeg',
          quality: 80,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 800, height: 600, scale: 0.5 },
        },
      },
      5_000,
    );
    expect(bridge.listeners.size).toBe(0);
  });

  it.each(['hidden', 'start-error', 'wrong-size', 'invalid-image'])(
    'falls back after %s and releases its listeners',
    async (failure) => {
      const bridge = new ScreenshotBridge();
      bridge.onStart = () => {
        if (failure === 'hidden')
          bridge.emit({
            type: 'event',
            tabId: 17,
            method: 'Page.screencastVisibilityChanged',
            params: { visible: false },
          });
        else if (failure === 'start-error')
          throw new Error('Screencast unavailable');
        else
          bridge.frame({
            data:
              failure === 'wrong-size'
                ? jpeg(400, 300).toString('base64')
                : 'invalid',
          });
      };
      await expect(
        captureTabScreenshot(tab(), {}, bridge),
      ).resolves.toMatchObject({ width: 800, height: 600 });
      expect(bridge.methods()).toContain('Page.stopScreencast');
      expect(bridge.methods()).toContain('Page.captureScreenshot');
      expect(bridge.listeners.size).toBe(0);
    },
  );

  it('does not let cleanup failure lose a captured frame', async () => {
    const bridge = new ScreenshotBridge();
    bridge.onStop = () => {
      throw new Error('Cleanup failed');
    };
    await expect(
      captureTabScreenshot(tab(), {}, bridge),
    ).resolves.toMatchObject({ width: 800 });
    expect(bridge.methods()).not.toContain('Page.captureScreenshot');
    expect(bridge.methods().at(-1)).toBe('Page.screencastFrameAck');
  });

  it('serializes captures on the same tab, including recovery after failure', async () => {
    const bridge = new ScreenshotBridge();
    const target = tab();
    let complete: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    bridge.onStart = async () => {
      await blocked;
      throw new Error('No screencast');
    };
    bridge.onCapture = () => {
      throw new Error('Capture timed out');
    };
    const first = captureTabScreenshot(target, {}, bridge);
    const rejected = first.catch((error: unknown) => error);
    const second = captureTabScreenshot(target, {}, bridge);
    await vi.waitFor(() =>
      expect(bridge.methods()).toContain('Page.startScreencast'),
    );
    expect(
      bridge.methods().filter((x) => x === 'Page.getLayoutMetrics'),
    ).toHaveLength(1);
    bridge.onStart = () => bridge.frame();
    complete();
    expect(await rejected).toMatchObject({ message: 'Capture timed out' });
    await expect(second).resolves.toMatchObject({ width: 800 });
    expect(bridge.listeners.size).toBe(0);
  });

  it('preserves viewport-relative crop coordinates after scrolling', async () => {
    const bridge = new ScreenshotBridge();
    bridge.viewport.pageX = 120;
    bridge.viewport.pageY = 700;
    bridge.captureData = jpeg(200, 100).toString('base64');
    await captureTabScreenshot(
      tab(),
      { clip: { x: 10, y: 20, width: 200, height: 100 } },
      bridge,
    );
    expect(bridge.methods()).not.toContain('Page.startScreencast');
    expect(bridge.request).toHaveBeenCalledWith(
      'cdp.send',
      {
        tabId: 17,
        method: 'Page.captureScreenshot',
        params: {
          format: 'jpeg',
          quality: 80,
          captureBeyondViewport: true,
          clip: { x: 130, y: 720, width: 200, height: 100, scale: 0.5 },
        },
      },
      5_000,
    );
  });

  it('uses content dimensions for full-page capture', async () => {
    const bridge = new ScreenshotBridge();
    bridge.viewport.pageY = 300;
    bridge.captureData = jpeg(800, 1200).toString('base64');
    await expect(
      captureTabScreenshot(tab(), { fullPage: true }, bridge),
    ).resolves.toMatchObject({ width: 800, height: 1200 });
    expect(bridge.methods()).not.toContain('Page.startScreencast');
    expect(bridge.request.mock.calls.at(-1)?.[1]?.params).toMatchObject({
      clip: { x: 0, y: 0, width: 800, height: 1200, scale: 0.5 },
    });
  });

  it('does not shrink a large viewport to the explicit-crop pixel budget', async () => {
    const bridge = new ScreenshotBridge();
    bridge.viewport.clientWidth = 2560;
    bridge.viewport.clientHeight = 1440;
    await expect(
      captureTabScreenshot(tab(), {}, bridge),
    ).resolves.toMatchObject({ width: 2560, height: 1440 });
    expect(bridge.methods()).not.toContain('Page.captureScreenshot');
  });

  it('bypasses screencast if it would have to upscale pixels', async () => {
    const bridge = new ScreenshotBridge();
    bridge.pixelRatio = 0.8;
    await captureTabScreenshot(tab(), {}, bridge);
    expect(bridge.methods()).not.toContain('Page.startScreencast');
    expect(bridge.request.mock.calls.at(-1)?.[1]?.params).toMatchObject({
      clip: { scale: 1.25 },
    });
  });

  it('rejects oversized full-page requests before capture', async () => {
    const bridge = new ScreenshotBridge();
    bridge.content.height = 10_000;
    await expect(
      captureTabScreenshot(tab(), { fullPage: true }, bridge),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(bridge.methods()).not.toContain('Page.captureScreenshot');
  });

  it.each(['', 'not an image'])(
    'rejects unusable capture results: %j',
    async (data) => {
      const bridge = new ScreenshotBridge();
      bridge.captureData = data;
      await expect(
        captureTabScreenshot(tab(), { fullPage: true }, bridge),
      ).rejects.toMatchObject({ code: 'OPERATION_FAILED' });
    },
  );

  it('parses baseline and progressive JPEG dimensions past metadata segments', () => {
    const image = jpeg(1280, 720);
    const withMetadata = Buffer.concat([
      image.subarray(0, 2),
      Buffer.from([0xff, 0xe0, 0, 4, 0, 0]),
      image.subarray(2),
    ]);
    expect(jpegDimensions(withMetadata)).toEqual({ width: 1280, height: 720 });
    image[3] = 0xc2;
    expect(jpegDimensions(image)).toEqual({ width: 1280, height: 720 });
    expect(() => jpegDimensions(image.subarray(0, 12))).toThrow('invalid JPEG');
  });
});
