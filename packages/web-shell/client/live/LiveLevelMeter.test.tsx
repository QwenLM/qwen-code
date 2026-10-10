/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveLevelMeter, LIVE_LEVEL_PROPERTY } from './LiveLevelMeter';
import type { LiveInputLevel } from './useLiveBrowserHost';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let frames: FrameRequestCallback[] = [];
let cancelled: number[] = [];
let clock = 0;

/** Advance the display by `count` frames of `intervalMs` each. */
function paintFrames(count = 1, intervalMs = 1000 / 60): void {
  for (let i = 0; i < count; i++) {
    clock += intervalMs;
    const pending = frames;
    frames = [];
    act(() => {
      pending.forEach((frame) => frame(clock));
    });
  }
}

/** An audio frame captured "now", as the capture callback would record it. */
function heard(
  value: { current: LiveInputLevel },
  level: number,
  dropping = false,
): void {
  value.current = { level, at: clock, dropping };
}

function meter(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-live-level-meter]')!;
}

function level(): number {
  const bar = meter().querySelector<HTMLElement>('div');
  return Number(bar?.style.getPropertyValue(LIVE_LEVEL_PROPERTY) ?? '');
}

function input(): { current: LiveInputLevel } {
  return { current: { level: 0, at: clock, dropping: false } };
}

const onDroppingChange = vi.fn();

function meterElement(
  value: { current: LiveInputLevel },
  muted: boolean,
): React.JSX.Element {
  return (
    <LiveLevelMeter
      level={value}
      muted={muted}
      label="mic"
      droppingLabel="not reaching the daemon"
      onDroppingChange={onDroppingChange}
    />
  );
}

function mount(value: { current: LiveInputLevel }, muted = false): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(meterElement(value, muted)));
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  frames = [];
  cancelled = [];
  clock = 10_000;
  onDroppingChange.mockReset();
  let nextHandle = 1;
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => {
    frames.push(frame);
    return nextHandle++;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    cancelled.push(handle);
  });
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('LiveLevelMeter', () => {
  it('follows speech up immediately and lets it fall back gradually', () => {
    const value = input();
    mount(value);

    // Raw RMS is small; the meter amplifies it the way dictation's does.
    heard(value, 0.05);
    paintFrames();
    expect(level()).toBeCloseTo(0.4, 3);

    // A louder frame is taken at once...
    heard(value, 0.1);
    paintFrames();
    expect(level()).toBeCloseTo(0.8, 3);

    // ...and silence decays instead of snapping to zero, so the bar reads as
    // a voice rather than flickering once per audio frame.
    heard(value, 0);
    paintFrames();
    expect(level()).toBeCloseTo(0.68, 2);
    for (let i = 0; i < 10; i++) {
      heard(value, 0);
      paintFrames();
    }
    expect(level()).toBeLessThan(0.2);
  });

  it('falls at the same speed whatever the display refresh rate', () => {
    // One audio frame apart (~64 ms), on a 60 Hz and on a 144 Hz display.
    const falls = [1000 / 60, 1000 / 144].map((interval) => {
      for (const { root, container } of mounted.splice(0)) {
        act(() => root.unmount());
        container.remove();
      }
      frames = [];
      const value = input();
      mount(value);
      heard(value, 0.125);
      paintFrames(1, interval);
      const peak = level();
      const steps = Math.round(64 / interval);
      for (let i = 0; i < steps; i++) {
        heard(value, 0);
        paintFrames(1, interval);
      }
      return level() / peak;
    });

    // Per-frame decay would leave ~52% at 60 Hz but ~23% at 144 Hz: the bar
    // would saw-tooth between audio frames on a fast display.
    expect(falls[0]).toBeGreaterThan(0.45);
    expect(falls[1]).toBeGreaterThan(0.45);
    expect(Math.abs(falls[0]! - falls[1]!)).toBeLessThan(0.06);
  });

  it('drops to zero when audio frames stop arriving, instead of freezing', () => {
    const value = input();
    mount(value);
    heard(value, 0.1);
    paintFrames();
    expect(level()).toBeCloseTo(0.8, 3);

    // The capture callback stalls (suspended AudioContext, device change):
    // the ref keeps its last level and its old timestamp.
    paintFrames(15); // 250 ms
    const afterStall = level();
    paintFrames(60); // a further second
    expect(afterStall).toBeLessThan(0.8);
    expect(level()).toBe(0);
  });

  it('shows that frames are being dropped rather than sent', () => {
    const value = input();
    mount(value);
    expect(meter().dataset['dropping']).toBe('false');
    expect(meter().title).toBe('mic');

    heard(value, 0.1, true);
    paintFrames();
    // The bar still follows the voice: the microphone is not the problem.
    expect(level()).toBeGreaterThan(0);
    expect(meter().dataset['dropping']).toBe('true');
    expect(meter().title).toBe('not reaching the daemon');

    heard(value, 0.1, false);
    paintFrames();
    expect(meter().dataset['dropping']).toBe('false');
    expect(meter().title).toBe('mic');
  });

  it('reports a dropping flip once, not on every frame, and never the initial "fine"', () => {
    const value = input();
    mount(value);
    heard(value, 0.1);
    paintFrames(5);
    // "Not dropping" is what the dialog already assumes.
    expect(onDroppingChange).not.toHaveBeenCalled();

    for (let i = 0; i < 20; i++) {
      heard(value, 0.1, true);
      paintFrames();
    }
    expect(onDroppingChange.mock.calls).toEqual([[true]]);

    for (let i = 0; i < 20; i++) {
      heard(value, 0.1, false);
      paintFrames();
    }
    expect(onDroppingChange.mock.calls).toEqual([[true], [false]]);
  });

  it('withdraws a dropping report when it is muted or goes away', () => {
    const value = input();
    mount(value);
    heard(value, 0.1, true);
    paintFrames();
    expect(onDroppingChange).toHaveBeenLastCalledWith(true);

    const { root } = mounted[0]!;
    act(() => root.render(meterElement(value, true)));
    expect(onDroppingChange).toHaveBeenLastCalledWith(false);
  });

  it('paints zero and stops animating when input becomes muted mid-call', () => {
    const value = input();
    const container = mount(value);
    heard(value, 0.1);
    paintFrames();
    expect(level()).toBeCloseTo(0.8, 3);
    expect(frames).toHaveLength(1);

    const bar = container.querySelector<HTMLElement>(
      '[data-live-level-meter] > div',
    )!;
    const paint = vi.spyOn(bar.style, 'setProperty');
    const { root } = mounted[0]!;
    act(() => root.render(meterElement(value, true)));

    // An actual paint of 0 — `level()` alone reads 0 for "never painted" too.
    expect(paint).toHaveBeenCalledWith(LIVE_LEVEL_PROPERTY, '0.000');
    expect(cancelled).not.toHaveLength(0);
    // And nothing is queued any more: the loop is over, not idling.
    frames = [];
    paintFrames(5);
    expect(level()).toBe(0);
    expect(frames).toHaveLength(0);
  });

  it('settles at zero and stops rewriting the same value', () => {
    const value = input();
    const container = mount(value);
    heard(value, 0.1);
    paintFrames();
    for (let i = 0; i < 60; i++) {
      heard(value, 0);
      paintFrames();
    }
    expect(level()).toBe(0);

    const bar = container.querySelector<HTMLElement>(
      '[data-live-level-meter] > div',
    )!;
    const spy = vi.spyOn(bar.style, 'setProperty');
    paintFrames(30);
    // Silence must not repaint the property on every frame.
    expect(spy).not.toHaveBeenCalled();
  });

  it('clamps a loud frame to the top of the meter', () => {
    const value = input();
    mount(value);
    heard(value, 1);
    paintFrames();
    expect(level()).toBe(1);
  });

  it('holds at zero while input is muted, and does not animate', () => {
    const value = input();
    heard(value, 0.5);
    mount(value, true);

    expect(level()).toBe(0);
    expect(frames).toHaveLength(0);
    expect(meter().getAttribute('data-muted')).toBe('true');
  });

  it('stops painting once it is gone', () => {
    const value = input();
    mount(value);
    paintFrames();
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();

    expect(cancelled).not.toHaveLength(0);
  });

  it('is decorative: the call state beside it carries the meaning', () => {
    mount(input());
    expect(meter().getAttribute('aria-hidden')).toBe('true');
    expect(meter().getAttribute('title')).toBe('mic');
  });
});
