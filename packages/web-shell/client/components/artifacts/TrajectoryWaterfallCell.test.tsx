// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentProps } from 'react';
import type { TimelineSpan } from '../../trajectory/buildTimeline';
import type { TrajectoryRow } from '../../trajectory/types';
import { TrajectoryWaterfallCell } from './TrajectoryWaterfallCell';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  mounted.forEach(({ root, container }) => {
    act(() => root.unmount());
    container.remove();
  });
  mounted.length = 0;
});
function draw(props: ComponentProps<typeof TrajectoryWaterfallCell>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => root.render(<TrajectoryWaterfallCell {...props} />));
  return container;
}
function span(start: number, end: number, ttftEnd?: number): TimelineSpan {
  return {
    rowKey: 'tool:A',
    row: { kind: 'tool' } as TrajectoryRow,
    start,
    end,
    lane: 1,
    error: false,
    ttftEnd,
  };
}
function bar(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    '[data-testid="trajectory-waterfall-span"]',
  );
}
describe('TrajectoryWaterfallCell', () => {
  it('draws overlapping tools in the same shared viewport coordinates', () => {
    const viewport = { start: 800, end: 1600 };
    const a = bar(draw({ span: span(800, 1400), total: 4500, viewport }));
    const b = bar(draw({ span: span(1000, 1600), total: 4500, viewport }));
    expect(a?.style.left).toBe('0%');
    expect(a?.style.width).toBe('75%');
    expect(b?.style.left).toBe('25%');
    expect(b?.style.width).toBe('75%');
  });
  it('clips TTFT and the committed time range to the viewport', () => {
    const container = draw({
      span: span(0, 1000, 700),
      total: 4500,
      viewport: { start: 500, end: 900 },
      range: { start: 400, end: 800 },
    });
    expect(bar(container)?.style.width).toBe('100%');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="trajectory-waterfall-ttft"]',
      )?.style.width,
    ).toBe('50%');
    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="trajectory-waterfall-range"]',
      )?.style.width,
    ).toBe('75%');
  });
  it('does not draw an offscreen span or TTFT that ended before the viewport', () => {
    expect(
      bar(
        draw({
          span: span(0, 100),
          total: 1000,
          viewport: { start: 500, end: 900 },
        }),
      ),
    ).toBeNull();
    const container = draw({
      span: span(0, 1000, 100),
      total: 1000,
      viewport: { start: 500, end: 900 },
    });
    expect(
      container.querySelector('[data-testid="trajectory-waterfall-ttft"]'),
    ).toBeNull();
  });
  it('keeps zero timing finite and has no focusable controls', () => {
    const container = draw({ span: span(0, 0), total: 0 });
    expect(bar(container)?.dataset.zero).toBe('true');
    expect(bar(container)?.style.left).toBe('0%');
    expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(container.querySelector('button,[tabindex]')).toBeNull();
  });
  it('retains the last zero-duration marker inside the right edge', () => {
    const container = draw({ span: span(1000, 1000), total: 1000 });
    expect(bar(container)?.dataset.atEnd).toBe('true');
    expect(bar(container)?.style.left).toBe('100%');
  });
  it('shows no invented bar for missing timing', () => {
    const container = draw({ total: 1000 });
    expect(container.textContent).toBe('—');
    expect(bar(container)).toBeNull();
  });
});
