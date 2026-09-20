/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveLevelMeter, LIVE_LEVEL_PROPERTY } from './LiveLevelMeter';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
let frames: FrameRequestCallback[] = [];
let cancelled: number[] = [];

/** Run the animation frames the meter has queued, once. */
function paintFrames(count = 1): void {
  for (let i = 0; i < count; i++) {
    const pending = frames;
    frames = [];
    act(() => {
      pending.forEach((frame) => frame(performance.now()));
    });
  }
}

function level(): number {
  const bar = document.querySelector<HTMLElement>(
    '[data-live-level-meter] > div',
  );
  return Number(bar?.style.getPropertyValue(LIVE_LEVEL_PROPERTY) ?? '');
}

function mount(node: React.JSX.Element): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

beforeEach(() => {
  frames = [];
  cancelled = [];
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
    const value = createRef<number>() as { current: number };
    value.current = 0;
    mount(<LiveLevelMeter level={value} muted={false} label="mic" />);

    // Raw RMS is small; the meter amplifies it the way dictation's does.
    value.current = 0.05;
    paintFrames();
    expect(level()).toBeCloseTo(0.4, 3);

    // A louder frame is taken at once...
    value.current = 0.1;
    paintFrames();
    expect(level()).toBeCloseTo(0.8, 3);

    // ...and silence decays instead of snapping to zero, so the bar reads as
    // a voice rather than flickering once per audio frame.
    value.current = 0;
    paintFrames();
    expect(level()).toBeCloseTo(0.68, 2);
    paintFrames(10);
    expect(level()).toBeLessThan(0.2);
  });

  it('clamps a loud frame to the top of the meter', () => {
    const value = { current: 1 };
    mount(<LiveLevelMeter level={value} muted={false} label="mic" />);
    paintFrames();
    expect(level()).toBe(1);
  });

  it('holds at zero while input is muted, and does not animate', () => {
    const value = { current: 0.5 };
    mount(<LiveLevelMeter level={value} muted={true} label="muted" />);

    expect(level()).toBe(0);
    expect(frames).toHaveLength(0);
    expect(
      document
        .querySelector('[data-live-level-meter]')
        ?.getAttribute('data-muted'),
    ).toBe('true');
  });

  it('stops painting once it is gone', () => {
    const value = { current: 0.5 };
    mount(<LiveLevelMeter level={value} muted={false} label="mic" />);
    paintFrames();
    const { root, container } = mounted.pop()!;
    act(() => root.unmount());
    container.remove();

    expect(cancelled).not.toHaveLength(0);
  });

  it('is decorative: the call state beside it carries the meaning', () => {
    mount(<LiveLevelMeter level={{ current: 0 }} muted={false} label="mic" />);
    const meter = document.querySelector('[data-live-level-meter]');
    expect(meter?.getAttribute('aria-hidden')).toBe('true');
    expect(meter?.getAttribute('title')).toBe('mic');
  });
});
