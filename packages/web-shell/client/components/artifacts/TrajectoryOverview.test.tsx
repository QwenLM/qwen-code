// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import {
  TrajectoryOverview,
  exactPercent,
  formatClockTime,
  formatWindowTime,
  type TrajectoryOverviewProps,
} from './TrajectoryOverview';
import type {
  TimelineModel,
  TimelineSpan,
} from '../../trajectory/buildTimeline';
import type { TrajectoryRow } from '../../trajectory/types';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
});

/** Render the last mounted overview again with new props, same root. */
let rerender: (props: Partial<TrajectoryOverviewProps>) => void = () => {};

function render(props: Partial<TrajectoryOverviewProps>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  rerender = (next) => draw(root, next);
  draw(root, props);
  return container;
}

function draw(root: Root, props: Partial<TrajectoryOverviewProps>) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TrajectoryOverview
          model={undefined}
          onSelect={() => {}}
          onRangeChange={() => {}}
          onModeChange={() => {}}
          describe={(span) => `about ${span.rowKey}`}
          {...props}
        />
      </I18nProvider>,
    );
  });
}

const ROW = { kind: 'message', key: 'x' } as unknown as TrajectoryRow;

function span(over: Partial<TimelineSpan>): TimelineSpan {
  return {
    rowKey: 'r',
    row: ROW,
    lane: 0,
    start: 0,
    end: 100,
    error: false,
    ...over,
  };
}

const MODEL: TimelineModel = {
  spans: [
    span({ rowKey: 'req', lane: 0, start: 0, end: 1000, ttftEnd: 400 }),
    span({ rowKey: 'tool', lane: 1, start: 1000, end: 1500 }),
    span({ rowKey: 'sub', lane: 2, start: 1500, end: 2000, error: true }),
  ],
  turnMarks: [{ turnIndex: 2, at: 1500 }],
  mode: 'active',
  total: 2000,
  activeMs: 2000,
  originMs: 0,
  droppedRows: 0,
};

/** Where the clock-mode fixture starts, as a local wall-clock moment. */
const ORIGIN = new Date(2026, 8, 24, 14, 5, 6).getTime();

/**
 * Two turns a minute apart, on a real-time axis: a request and its tool, then
 * nearly a minute of nothing, then a failed subagent request.
 */
const CLOCK_MODEL: TimelineModel = {
  spans: [
    span({ rowKey: 'req', lane: 0, start: 0, end: 1000, ttftEnd: 400 }),
    span({ rowKey: 'tool', lane: 1, start: 1000, end: 1250 }),
    span({
      rowKey: 'sub',
      lane: 2,
      start: 60_000,
      end: 60_500,
      error: true,
    }),
  ],
  turnMarks: [{ turnIndex: 2, at: 60_000 }],
  mode: 'clock',
  total: 60_500,
  activeMs: 1750,
  originMs: ORIGIN,
  droppedRows: 0,
};

/** The clock reading a test expects, spelt out apart from the code. */
function clockReading(epochMs: number, digits: 0 | 1 | 2 | 3): string {
  return new Intl.DateTimeFormat('en', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    ...(digits > 0 ? { fractionalSecondDigits: digits } : {}),
  }).format(epochMs);
}

/** Track geometry the pointer maths reads; jsdom lays nothing out. */
const PLOT_LEFT = 50;
const PLOT_WIDTH = 400;

/**
 * jsdom has no PointerEvent, and React only reads the native event's type, so
 * a MouseEvent of the pointer type reaches `onPointer*` with the fields set.
 */
function pointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
  button = 0,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    button,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function plotOf(container: HTMLElement): HTMLElement {
  const plot = container.querySelector<HTMLElement>(
    '[data-testid="trajectory-plot"]',
  )!;
  plot.getBoundingClientRect = () =>
    ({
      left: PLOT_LEFT,
      width: PLOT_WIDTH,
      top: 0,
      height: 48,
      right: PLOT_LEFT + PLOT_WIDTH,
      bottom: 48,
      x: PLOT_LEFT,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return plot;
}

/** Client x of a point `fraction` of the way along the track. */
const at = (fraction: number) => PLOT_LEFT + fraction * PLOT_WIDTH;

/** A wheel turn over the track; returns the event to read `defaultPrevented`. */
function wheel(
  target: Element,
  clientX: number,
  delta: {
    deltaX?: number;
    deltaY?: number;
    deltaMode?: number;
    ctrlKey?: boolean;
  },
): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX,
    ctrlKey: delta.ctrlKey ?? false,
    deltaX: delta.deltaX ?? 0,
    deltaY: delta.deltaY ?? 0,
    deltaMode: delta.deltaMode ?? 0,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function domainOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(
    '[data-testid="trajectory-domain"]',
  )!;
}

const layer = (container: HTMLElement) => {
  const domain = domainOf(container);
  return {
    left: domain.style.left,
    width: domain.style.width,
    zoomed: domain.dataset['zoomed'] === 'true',
  };
};

const button = (container: HTMLElement, name: 'in' | 'out' | 'reset') =>
  container.querySelector<HTMLButtonElement>(
    `[data-testid="trajectory-zoom-${name}"]`,
  )!;

const overviewOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="trajectory-overview"]');
const spansOf = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="trajectory-span"]'),
  );

describe('TrajectoryOverview', () => {
  it('keeps the same box whether it is loading, has nothing to draw, or draws', () => {
    // The box is what holds the rows below it still, so every state must
    // render it — with the same class, which is where its fixed height lives.
    const loading = overviewOf(render({}));
    const notice = overviewOf(render({ notice: 'Nothing timed.' }));
    const drawn = overviewOf(render({ model: MODEL }));

    for (const box of [loading, notice, drawn]) expect(box).not.toBeNull();
    expect(
      new Set([loading, notice, drawn].map((box) => box!.className)).size,
    ).toBe(1);
    expect(notice!.textContent).toBe('Nothing timed.');
    expect(spansOf(notice!.parentElement!)).toHaveLength(0);
  });

  it('places each span by its share of the active time', () => {
    const [req, tool, sub] = spansOf(render({ model: MODEL }));

    expect(req!.style.getPropertyValue('--left')).toBe('0%');
    expect(req!.style.getPropertyValue('--width')).toBe('50%');
    expect(req!.style.getPropertyValue('--ttft')).toBe('40%');
    expect(tool!.style.getPropertyValue('--left')).toBe('50%');
    expect(tool!.style.getPropertyValue('--width')).toBe('25%');
    expect(tool!.style.getPropertyValue('--ttft')).toBe('');
    expect(sub!.style.getPropertyValue('--left')).toBe('75%');
  });

  it('puts spans on their lanes and marks failures and turn starts', () => {
    const container = render({ model: MODEL });
    const [req, tool, sub] = spansOf(container);

    expect([req, tool, sub].map((el) => el!.dataset['lane'])).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(req!.dataset['ttft']).toBe('true');
    expect(sub!.dataset['error']).toBe('true');
    expect(tool!.dataset['error']).toBeUndefined();
    const marks = container.querySelectorAll<HTMLElement>(
      '[data-testid="trajectory-turn-mark"]',
    );
    expect(marks).toHaveLength(1);
    expect(marks[0]!.style.getPropertyValue('--left')).toBe('75%');
  });

  it('says how long things were running, not how long the session was open', () => {
    const container = render({ model: MODEL });
    expect(
      container.querySelector('[data-testid="trajectory-overview-busy"]')
        ?.textContent,
    ).toBe('2.0s active');
    expect(overviewOf(container)!.getAttribute('aria-label')).toBe(
      'Timeline of 3 timed records, 2.0s of activity',
    );
  });

  it('highlights the selected row and selects a clicked span', () => {
    const onSelect = vi.fn();
    const container = render({ model: MODEL, selectedKey: 'tool', onSelect });
    const spans = spansOf(container);

    expect(spans.filter((el) => el.dataset['current'] === 'true')).toEqual([
      spans[1],
    ]);
    pointer(spans[2]!, 'pointerdown', at(0.8));
    pointer(plotOf(container), 'pointerup', at(0.8));
    expect(onSelect).toHaveBeenCalledWith('sub');
  });

  describe('time selection', () => {
    it('turns a drag into a range in the model domain, either way round', () => {
      for (const [from, to] of [
        [0.25, 0.55],
        [0.55, 0.25],
      ] as const) {
        const onRangeChange = vi.fn();
        const container = render({ model: MODEL, onRangeChange });
        const plot = plotOf(container);
        pointer(plot, 'pointerdown', at(from));
        pointer(plot, 'pointermove', at(to));
        pointer(plot, 'pointerup', at(to));
        expect(onRangeChange).toHaveBeenCalledTimes(1);
        expect(onRangeChange).toHaveBeenCalledWith({ start: 500, end: 1100 });
      }
    });

    it('treats a press that barely moved as a click on the span under it', () => {
      const onSelect = vi.fn();
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onSelect, onRangeChange });
      const plot = plotOf(container);
      pointer(spansOf(container)[1]!, 'pointerdown', at(0.6));
      pointer(plot, 'pointermove', at(0.6) + 3);
      pointer(plot, 'pointerup', at(0.6) + 3);
      expect(onSelect).toHaveBeenCalledWith('tool');
      expect(onRangeChange).not.toHaveBeenCalled();
    });

    it('selects nothing when a drag starts on a span', () => {
      const onSelect = vi.fn();
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onSelect, onRangeChange });
      const plot = plotOf(container);
      pointer(spansOf(container)[1]!, 'pointerdown', at(0.6));
      pointer(plot, 'pointermove', at(0.9));
      pointer(plot, 'pointerup', at(0.9));
      expect(onSelect).not.toHaveBeenCalled();
      expect(onRangeChange).toHaveBeenCalledWith({ start: 1200, end: 1800 });
    });

    it('clears the range on a click on empty track', () => {
      const onRangeChange = vi.fn();
      const container = render({
        model: MODEL,
        range: { start: 0, end: 500 },
        onRangeChange,
      });
      const plot = plotOf(container);
      pointer(plot, 'pointerdown', at(0.3));
      pointer(plot, 'pointerup', at(0.3));
      expect(onRangeChange).toHaveBeenCalledWith(undefined);
    });

    it('draws the drag while it is under way and the committed range after', () => {
      const container = render({ model: MODEL });
      const plot = plotOf(container);
      const band = () =>
        container.querySelector<HTMLElement>(
          '[data-testid="trajectory-range"]',
        );
      expect(band()).toBeNull();
      pointer(plot, 'pointerdown', at(0.1));
      pointer(plot, 'pointermove', at(0.4));
      expect(band()!.dataset['draft']).toBe('true');
      expect(band()!.style.getPropertyValue('--left')).toBe('10%');
      expect(band()!.style.getPropertyValue('--width')).toBe('30%');
      pointer(plot, 'pointerup', at(0.4));
      // The parent holds no range here, so nothing is left drawn.
      expect(band()).toBeNull();
    });

    it('draws a committed range from its prop', () => {
      const container = render({
        model: MODEL,
        range: { start: 500, end: 1500 },
      });
      const band = container.querySelector<HTMLElement>(
        '[data-testid="trajectory-range"]',
      )!;
      expect(band.dataset['draft']).toBeUndefined();
      expect(band.style.getPropertyValue('--left')).toBe('25%');
      expect(band.style.getPropertyValue('--width')).toBe('50%');
    });

    it('fades what ran outside the range, but never the selected row', () => {
      const container = render({
        model: MODEL,
        range: { start: 1600, end: 1900 },
        selectedKey: 'req',
      });
      const dimmed = spansOf(container).map((el) => el.dataset['dimmed']);
      // req is outside but selected; tool is outside; sub is inside.
      expect(dimmed).toEqual([undefined, 'true', undefined]);
    });

    it('fades nothing without a range', () => {
      const container = render({ model: MODEL });
      expect(spansOf(container).filter((el) => el.dataset['dimmed'])).toEqual(
        [],
      );
    });

    it('clamps a drag that runs off either end to the track', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      pointer(plot, 'pointerdown', PLOT_LEFT - 50);
      pointer(plot, 'pointermove', PLOT_LEFT + PLOT_WIDTH + 100);
      pointer(plot, 'pointerup', PLOT_LEFT + PLOT_WIDTH + 100);
      expect(onRangeChange).toHaveBeenCalledWith({ start: 0, end: 2000 });
    });

    it('clears on a right click and keeps the browser menu away', () => {
      const onRangeChange = vi.fn();
      const container = render({
        model: MODEL,
        range: { start: 0, end: 500 },
        onRangeChange,
      });
      const plot = plotOf(container);
      // Linux and macOS raise the menu on the press, before the release.
      pointer(plot, 'pointerdown', at(0.5), 2);
      const menu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        plot.dispatchEvent(menu);
      });
      expect(menu.defaultPrevented).toBe(true);
      // The menu event itself clears nothing; the release that did not move
      // does, once.
      expect(onRangeChange).not.toHaveBeenCalled();
      pointer(plot, 'pointerup', at(0.5), 2);
      expect(onRangeChange).toHaveBeenCalledTimes(1);
      expect(onRangeChange).toHaveBeenCalledWith(undefined);
    });

    it('commits nothing when the press is cancelled', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      pointer(plot, 'pointerdown', at(0.1));
      pointer(plot, 'pointermove', at(0.5));
      pointer(plot, 'pointercancel', at(0.5));
      pointer(plot, 'pointerup', at(0.5));
      expect(onRangeChange).not.toHaveBeenCalled();
      expect(
        container.querySelector('[data-testid="trajectory-range"]'),
      ).toBeNull();
    });

    it('names the selected stretch to assistive technology', () => {
      const container = render({
        model: MODEL,
        range: { start: 500, end: 1500 },
      });
      expect(overviewOf(container)!.getAttribute('aria-label')).toBe(
        'Timeline of 3 timed records, 2.0s of activity, 500ms to 1.5s selected',
      );
    });
  });

  it('stacks a short call above a long one it runs beside', () => {
    // A 37 ms shell call and a 12.7 s delegation started within a millisecond
    // of each other in a recorded session; drawn in time order, the long bar
    // covered the short one entirely.
    const [long, short] = spansOf(
      render({
        model: {
          ...MODEL,
          spans: [
            span({ rowKey: 'agent', lane: 1, start: 0, end: 1800 }),
            span({ rowKey: 'echo', lane: 1, start: 0, end: 10 }),
          ],
          turnMarks: [],
          total: 2000,
        },
      }),
    );
    expect(Number(short!.style.getPropertyValue('--stack'))).toBeGreaterThan(
      Number(long!.style.getPropertyValue('--stack')),
    );
  });

  it('names each span through the table', () => {
    const [req] = spansOf(render({ model: MODEL }));
    expect(req!.title).toBe('about req');
  });

  it('draws a timeline of zero length without dividing by it', () => {
    const [only] = spansOf(
      render({
        model: {
          ...MODEL,
          spans: [span({ start: 0, end: 0 })],
          turnMarks: [],
          total: 0,
        },
      }),
    );
    expect(only!.style.getPropertyValue('--left')).toBe('0%');
    expect(only!.style.getPropertyValue('--width')).toBe('0%');
  });
  describe('viewport', () => {
    // MODEL spans 2000 ms. A wheel of -400 px at the middle zooms by
    // exp(-0.6): 1097.62 ms in view, from 451.19 to 1548.81 ms. These numbers
    // were worked out apart from the code, and are written out here so a
    // change to the formula shows up as a failure rather than a new answer.
    const zoomedMiddle = (container: HTMLElement) =>
      wheel(plotOf(container), at(0.5), { deltaY: -400 });

    it('draws the whole run in the track until it is zoomed', () => {
      const container = render({ model: MODEL });
      expect(layer(container)).toEqual({
        left: '0%',
        width: '100%',
        zoomed: false,
      });
    });

    it('zooms around the pointer and keeps the page from scrolling', () => {
      const container = render({ model: MODEL });
      const event = zoomedMiddle(container);
      expect(event.defaultPrevented).toBe(true);
      expect(layer(container)).toEqual({
        left: '-41.106%',
        width: '182.212%',
        zoomed: true,
      });
    });

    it('keeps the point under the pointer where it was', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      wheel(plot, at(0.25), { deltaY: -400 });
      // 500 ms was under the pointer before the zoom; it must still be.
      pointer(plot, 'pointerdown', at(0.25));
      pointer(plot, 'pointermove', at(0.25) + 20);
      pointer(plot, 'pointerup', at(0.25) + 20);
      expect(onRangeChange.mock.calls[0]![0].start).toBeCloseTo(500, 9);
    });

    it('reads a wheel that counts in lines as the pixels it stands for', () => {
      const container = render({ model: MODEL });
      wheel(plotOf(container), at(0.5), { deltaY: -25, deltaMode: 1 });
      expect(layer(container).width).toBe('182.212%');
    });

    it('reads a wheel that counts in pages as a track width each', () => {
      const container = render({ model: MODEL });
      // One page is the 400px track: the same zoom as -400px.
      wheel(plotOf(container), at(0.5), { deltaY: -1, deltaMode: 2 });
      expect(layer(container).width).toBe('182.212%');
    });

    it('leaves a pinch and Ctrl with the wheel to the browser', () => {
      const container = render({ model: MODEL });
      const event = wheel(plotOf(container), at(0.5), {
        deltaY: -400,
        ctrlKey: true,
      });
      expect(event.defaultPrevented).toBe(false);
      expect(layer(container).zoomed).toBe(false);
    });

    it('goes back to the whole run, and then lets the page scroll', () => {
      const container = render({ model: MODEL });
      zoomedMiddle(container);
      wheel(plotOf(container), at(0.5), { deltaY: 2000 });
      expect(layer(container)).toEqual({
        left: '0%',
        width: '100%',
        zoomed: false,
      });
      const again = wheel(plotOf(container), at(0.5), { deltaY: 100 });
      expect(again.defaultPrevented).toBe(false);
    });

    it('keeps a zoom out near the end of the run inside the run', () => {
      const container = render({ model: MODEL });
      const plot = plotOf(container);
      // In at 90%: 812.14–1909.76 ms. Out by exp(0.3) around 10% would reach
      // 2255 ms, past the end, so the stretch is pushed back to finish there.
      wheel(plot, at(0.9), { deltaY: -400 });
      wheel(plot, at(0.1), { deltaY: 200 });
      expect(layer(container)).toEqual({
        left: '-34.986%',
        width: '134.986%',
        zoomed: true,
      });
    });

    it('stops at the narrowest stretch', () => {
      const container = render({ model: MODEL });
      wheel(plotOf(container), at(0.5), { deltaY: -100_000 });
      expect(layer(container).width).toBe('10000%');
      expect(button(container, 'in').getAttribute('aria-disabled')).toBe(
        'true',
      );
    });

    it('stops a long run at a 5000th of its length, inside layout limits', () => {
      // One hour: at a 20ms floor the layer would be 180,000 track widths,
      // past what browsers lay out.
      const container = render({
        model: {
          ...MODEL,
          spans: [span({ rowKey: 'only', start: 0, end: 3_600_000 })],
          turnMarks: [],
          total: 3_600_000,
        },
      });
      wheel(plotOf(container), at(0.5), { deltaY: -100_000 });
      expect(layer(container).width).toBe('500000%');
      expect(button(container, 'in').getAttribute('aria-disabled')).toBe(
        'true',
      );
    });

    it('pans a zoomed strip sideways, up to the end of the run', () => {
      const container = render({ model: MODEL });
      zoomedMiddle(container);
      const event = wheel(plotOf(container), at(0.5), { deltaX: 100_000 });
      expect(event.defaultPrevented).toBe(true);
      expect(layer(container).left).toBe('-82.212%');
    });

    it('leaves a sideways swipe alone when there is nowhere to pan', () => {
      const container = render({ model: MODEL });
      const event = wheel(plotOf(container), at(0.5), { deltaX: 300 });
      expect(event.defaultPrevented).toBe(false);
      expect(layer(container).zoomed).toBe(false);
    });

    it('pans with the right button and leaves the selection alone', () => {
      const onRangeChange = vi.fn();
      const container = render({
        model: MODEL,
        range: { start: 0, end: 500 },
        onRangeChange,
      });
      const plot = plotOf(container);
      zoomedMiddle(container);
      // Dragging left by a quarter of the track brings later time into view.
      pointer(plot, 'pointerdown', at(0.5), 2);
      pointer(plot, 'pointermove', at(0.25), 2);
      expect(plot.dataset['panning']).toBe('true');
      pointer(plot, 'pointerup', at(0.25), 2);
      expect(layer(container).left).toBe('-66.106%');
      expect(plot.dataset['panning']).toBeUndefined();
      expect(onRangeChange).not.toHaveBeenCalled();
    });

    it('still clears on a right click that wobbled, where there is nothing to pan', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      // 6px of travel: past the drag threshold, but at the whole run nothing
      // can move, so this was a right click.
      pointer(plot, 'pointerdown', at(0.5), 2);
      pointer(plot, 'pointermove', at(0.5) + 6, 2);
      expect(plot.dataset['panning']).toBeUndefined();
      pointer(plot, 'pointerup', at(0.5) + 6, 2);
      expect(layer(container).zoomed).toBe(false);
      expect(onRangeChange).toHaveBeenCalledTimes(1);
      expect(onRangeChange).toHaveBeenCalledWith(undefined);
    });

    it('still clears on a right drag against the end the view is pinned to', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      // Zoomed at the very start: dragging right asks for earlier time, and
      // there is none.
      wheel(plot, at(0), { deltaY: -400 });
      expect(layer(container).left).toBe('0%');
      pointer(plot, 'pointerdown', at(0.3), 2);
      pointer(plot, 'pointermove', at(0.6), 2);
      pointer(plot, 'pointerup', at(0.6), 2);
      expect(layer(container).left).toBe('0%');
      expect(onRangeChange).toHaveBeenCalledWith(undefined);
    });

    it('ignores the other button while one press is under way', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      pointer(plot, 'pointerdown', at(0.1));
      pointer(plot, 'pointerdown', at(0.5), 2);
      pointer(plot, 'pointermove', at(0.4));
      pointer(plot, 'pointerup', at(0.4));
      expect(onRangeChange).toHaveBeenCalledTimes(1);
      expect(onRangeChange).toHaveBeenCalledWith({ start: 200, end: 800 });
    });

    it('does not zoom under a drag in progress', () => {
      const container = render({ model: MODEL });
      const plot = plotOf(container);
      pointer(plot, 'pointerdown', at(0.1));
      pointer(plot, 'pointermove', at(0.4));
      const event = wheel(plot, at(0.4), { deltaY: -400 });
      expect(event.defaultPrevented).toBe(false);
      expect(layer(container).zoomed).toBe(false);
    });

    it('does not zoom under a right-button pan either', () => {
      const container = render({ model: MODEL });
      const plot = plotOf(container);
      zoomedMiddle(container);
      pointer(plot, 'pointerdown', at(0.5), 2);
      pointer(plot, 'pointermove', at(0.25), 2);
      const event = wheel(plot, at(0.25), { deltaY: -400 });
      expect(event.defaultPrevented).toBe(false);
      expect(layer(container).width).toBe('182.212%');
    });

    it('lets go of a pan the browser cancelled', () => {
      const container = render({ model: MODEL });
      const plot = plotOf(container);
      zoomedMiddle(container);
      pointer(plot, 'pointerdown', at(0.5), 2);
      pointer(plot, 'pointermove', at(0.25), 2);
      pointer(plot, 'pointercancel', at(0.25), 2);
      expect(plot.dataset['panning']).toBeUndefined();
      // Nothing is left holding the strip: the wheel zooms again.
      const event = wheel(plot, at(0.5), { deltaY: -400 });
      expect(event.defaultPrevented).toBe(true);
    });

    it('abandons a drag when the right button is pressed during it', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      pointer(plot, 'pointerdown', at(0.1));
      pointer(plot, 'pointermove', at(0.4));
      // A browser raises only the menu event for a second button pressed
      // while the first is held.
      const menu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        plot.dispatchEvent(menu);
      });
      expect(
        container.querySelector('[data-testid="trajectory-range"]'),
      ).toBeNull();
      pointer(plot, 'pointerup', at(0.4));
      expect(onRangeChange).toHaveBeenCalledTimes(1);
      expect(onRangeChange).toHaveBeenCalledWith(undefined);
    });

    it('selects time through the zoom', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      zoomedMiddle(container);
      pointer(plot, 'pointerdown', at(0.2));
      pointer(plot, 'pointermove', at(0.6));
      pointer(plot, 'pointerup', at(0.6));
      const range = onRangeChange.mock.calls[0]![0];
      expect(range.start).toBeCloseTo(670.713, 3);
      expect(range.end).toBeCloseTo(1109.762, 3);
    });

    it('stops a drag at the edges of what is in view', () => {
      const onRangeChange = vi.fn();
      const container = render({ model: MODEL, onRangeChange });
      const plot = plotOf(container);
      zoomedMiddle(container);
      pointer(plot, 'pointerdown', PLOT_LEFT - 50);
      pointer(plot, 'pointermove', PLOT_LEFT + PLOT_WIDTH + 50);
      pointer(plot, 'pointerup', PLOT_LEFT + PLOT_WIDTH + 50);
      const range = onRangeChange.mock.calls[0]![0];
      expect(range.start).toBeCloseTo(451.188, 3);
      expect(range.end).toBeCloseTo(1548.812, 3);
    });

    it('zooms from the buttons around the middle of what is in view', () => {
      const container = render({ model: MODEL });
      act(() => button(container, 'in').click());
      // One wheel notch: exp(-0.18), 1670.54 ms centred on 1000 ms.
      expect(layer(container)).toEqual({
        left: '-9.861%',
        width: '119.722%',
        zoomed: true,
      });
      act(() => button(container, 'out').click());
      expect(layer(container).zoomed).toBe(false);
    });

    it('zooms from the buttons around where the view is, not the run', () => {
      const container = render({ model: MODEL });
      // In at 90%: 812.14–1909.76 ms, centred on 1360.95 ms. The button then
      // narrows to 916.81 ms about that centre: 902.54–1819.36 ms.
      wheel(plotOf(container), at(0.9), { deltaY: -400 });
      act(() => button(container, 'in').click());
      expect(layer(container)).toEqual({
        left: '-98.444%',
        width: '218.147%',
        zoomed: true,
      });
    });

    it('offers reset and zoom out only once zoomed, without disabling them', () => {
      const container = render({ model: MODEL });
      for (const name of ['out', 'reset'] as const) {
        expect(button(container, name).getAttribute('aria-disabled')).toBe(
          'true',
        );
        expect(button(container, name).disabled).toBe(false);
      }
      zoomedMiddle(container);
      expect(button(container, 'reset').getAttribute('aria-disabled')).toBe(
        null,
      );
      act(() => button(container, 'reset').click());
      expect(layer(container).zoomed).toBe(false);
    });

    it('keeps the buttons where assistive technology can reach them', () => {
      const container = render({ model: MODEL });
      for (const name of ['in', 'out', 'reset'] as const) {
        const el = button(container, name);
        expect(el.closest('[aria-hidden="true"]')).toBeNull();
        expect(el.getAttribute('aria-label')).toBeTruthy();
      }
      expect(overviewOf(container)!.getAttribute('role')).toBe('group');
    });

    it('says which stretch is in view', () => {
      const container = render({ model: MODEL });
      zoomedMiddle(container);
      expect(
        container.querySelector('[data-testid="trajectory-overview-from"]')!
          .textContent,
      ).toBe('451ms');
      expect(
        container.querySelector('[data-testid="trajectory-overview-busy"]')!
          .textContent,
      ).toBe('1.5s of 2.0s');
      expect(overviewOf(container)!.getAttribute('aria-label')).toBe(
        'Timeline of 3 timed records, 2.0s of activity, zoomed to 451ms–1.5s',
      );
    });

    it('says a zoom out loud, and nothing at the whole run', () => {
      const container = render({ model: MODEL });
      const status = container.querySelector<HTMLElement>(
        '[data-testid="trajectory-zoom-status"]',
      )!;
      expect(status.getAttribute('role')).toBe('status');
      expect(status.closest('[aria-hidden="true"]')).toBeNull();
      expect(status.textContent).toBe('');
      act(() => button(container, 'in').click());
      // 164.73–1835.27 ms: a 1.7s window, shown to a tenth of a second.
      expect(status.textContent).toBe('Showing 165ms–1.8s of 2.0s');
    });

    it('names the two ends of a narrow window apart', () => {
      const container = render({ model: MODEL });
      // The 20ms floor about the middle: 990–1010 ms.
      wheel(plotOf(container), at(0.5), { deltaY: -100_000 });
      expect(
        container.querySelector('[data-testid="trajectory-overview-from"]')!
          .textContent,
      ).toBe('990ms');
      expect(
        container.querySelector('[data-testid="trajectory-overview-busy"]')!
          .textContent,
      ).toBe('1.010s of 2.0s');
    });

    it('brings a row selected elsewhere into view', () => {
      const container = render({ model: MODEL });
      // Zoomed on the start of the run, 0–1097.62 ms.
      wheel(plotOf(container), at(0), { deltaY: -400 });
      // A selection inside the view moves nothing.
      rerender({ model: MODEL, selectedKey: 'req' });
      expect(layer(container).left).toBe('0%');
      // 'sub' runs 1500–2000 ms, past the view: it slides as far as the run
      // allows, which leaves the span inside.
      rerender({ model: MODEL, selectedKey: 'sub' });
      expect(layer(container)).toEqual({
        left: '-82.212%',
        width: '182.212%',
        zoomed: true,
      });
    });

    it('draws a run of no length without dividing by it', () => {
      const container = render({
        model: {
          ...MODEL,
          spans: [span({ start: 0, end: 0 })],
          turnMarks: [],
          total: 0,
        },
      });
      expect(layer(container)).toEqual({
        left: '0%',
        width: '100%',
        zoomed: false,
      });
    });

    it('places spans exactly, however far the layer is stretched', () => {
      const container = render({
        model: {
          ...MODEL,
          spans: [span({ rowKey: 'x', start: 1_234_567, end: 1_234_600 })],
          turnMarks: [],
          total: 3_600_000,
        },
      });
      // 34.293527777…%; rounded to three places it was hundreds of pixels
      // off at full zoom.
      expect(spansOf(container)[0]!.style.getPropertyValue('--left')).toBe(
        '34.29352778%',
      );
    });

    it('leaves each span placed in percent of the whole run', () => {
      const container = render({ model: MODEL });
      zoomedMiddle(container);
      const [req] = spansOf(container);
      expect(req!.style.getPropertyValue('--left')).toBe('0%');
      expect(req!.style.getPropertyValue('--width')).toBe('50%');
    });

    it('lets the zoom go when the run is read again', () => {
      const container = render({ model: MODEL });
      zoomedMiddle(container);
      expect(layer(container).zoomed).toBe(true);
      rerender({ model: { ...MODEL } });
      expect(layer(container).zoomed).toBe(false);
    });
  });

  describe('formatWindowTime', () => {
    it('follows the window, not the size of the number', () => {
      expect(formatWindowTime(451.19, 1097)).toBe('451ms');
      expect(formatWindowTime(1548.8, 1097)).toBe('1.5s');
      expect(formatWindowTime(1010, 20)).toBe('1.010s');
      expect(formatWindowTime(1505, 500)).toBe('1.51s');
      expect(formatWindowTime(1_018_490, 500)).toBe('16m 58.49s');
      expect(formatWindowTime(3_723_004, 20)).toBe('1h 2m 3.004s');
    });

    it('never prints sixty seconds', () => {
      expect(formatWindowTime(119_970, 5000)).toBe('2m 0.0s');
    });

    it('falls back to the everyday format for windows of a minute or more', () => {
      expect(formatWindowTime(90_000, 60_000)).toBe('1m 30s');
    });
  });

  describe('exactPercent', () => {
    it('keeps precision, drops trailing zeros, and never uses exponents', () => {
      expect(exactPercent(50)).toBe('50%');
      expect(exactPercent(-0)).toBe('0%');
      expect(exactPercent(1e-7)).toBe('0.0000001%');
      expect(exactPercent(100 / 3)).toBe('33.33333333%');
    });
  });

  describe('real time', () => {
    const modeSwitch = (container: HTMLElement) =>
      container.querySelector<HTMLButtonElement>(
        '[data-testid="trajectory-mode-clock"]',
      )!;
    const text = (container: HTMLElement, id: string) =>
      container.querySelector(`[data-testid="${id}"]`)!.textContent;

    it('offers the switch as a pressed state, where assistive technology can reach it', () => {
      const active = render({ model: MODEL });
      expect(modeSwitch(active).getAttribute('aria-pressed')).toBe('false');
      expect(modeSwitch(active).getAttribute('aria-label')).toBe(
        'Real time, idle included',
      );
      expect(modeSwitch(active).closest('[aria-hidden="true"]')).toBeNull();

      const clock = render({ model: CLOCK_MODEL });
      expect(modeSwitch(clock).getAttribute('aria-pressed')).toBe('true');
    });

    it('asks for the other mode, whichever is in force', () => {
      const onModeChange = vi.fn();
      const container = render({ model: MODEL, onModeChange });
      act(() => modeSwitch(container).click());
      expect(onModeChange).toHaveBeenLastCalledWith('clock');

      rerender({ model: CLOCK_MODEL, onModeChange });
      act(() => modeSwitch(container).click());
      expect(onModeChange).toHaveBeenLastCalledWith('active');
    });

    it('reads the axis as clock times, and says elapsed and active apart', () => {
      const container = render({ model: CLOCK_MODEL });
      // A minute in view: whole seconds.
      expect(text(container, 'trajectory-overview-from')).toBe(
        clockReading(ORIGIN, 0),
      );
      expect(text(container, 'trajectory-overview-busy')).toBe(
        '1m elapsed, 1.8s active',
      );
      expect(overviewOf(container)!.getAttribute('aria-label')).toBe(
        'Timeline of 3 timed records over 1m, 1.8s of activity',
      );
    });

    it('keeps the active axis as it was', () => {
      const container = render({ model: MODEL });
      expect(text(container, 'trajectory-overview-from')).toBe('0');
      expect(text(container, 'trajectory-overview-busy')).toBe('2.0s active');
    });

    it('names both ends of a zoomed window as clock times', () => {
      const container = render({ model: CLOCK_MODEL });
      // The 20ms floor about the middle of the minute: 30 240–30 260 ms.
      wheel(plotOf(container), at(0.5), { deltaY: -100_000 });
      expect(text(container, 'trajectory-overview-from')).toBe(
        clockReading(ORIGIN + 30_240, 3),
      );
      expect(text(container, 'trajectory-overview-busy')).toBe(
        clockReading(ORIGIN + 30_260, 3),
      );
    });

    it('names a selected stretch as clock times', () => {
      const container = render({
        model: CLOCK_MODEL,
        range: { start: 0, end: 1250 },
      });
      expect(overviewOf(container)!.getAttribute('aria-label')).toBe(
        'Timeline of 3 timed records over 1m, 1.8s of activity' +
          `, ${clockReading(ORIGIN, 1)} to ${clockReading(ORIGIN + 1250, 1)} selected`,
      );
    });

    it('drops the zoom when the mode changes', () => {
      const container = render({ model: MODEL });
      wheel(plotOf(container), at(0.5), { deltaY: -400 });
      expect(layer(container).zoomed).toBe(true);
      rerender({ model: CLOCK_MODEL });
      expect(layer(container).zoomed).toBe(false);
    });

    it('says the switch out loud, and a later zoom after it', () => {
      const container = render({ model: MODEL });
      const status = () => text(container, 'trajectory-zoom-status');
      wheel(plotOf(container), at(0.5), { deltaY: -400 });
      expect(status()).toMatch(/^Showing /);

      act(() => modeSwitch(container).click());
      rerender({ model: CLOCK_MODEL });
      expect(status()).toBe('Showing real time, idle included');

      act(() => button(container, 'in').click());
      expect(status()).toMatch(/^Showing \d{2}:\d{2}:\d{2}/);

      act(() => modeSwitch(container).click());
      rerender({ model: MODEL });
      expect(status()).toBe('Showing active time only');
    });

    it('places a short call in a long stretch of real time exactly', () => {
      const [, tool] = spansOf(render({ model: CLOCK_MODEL }));
      // 250 ms of 60 500.
      expect(tool!.style.getPropertyValue('--width')).toBe('0.41322314%');
      expect(tool!.style.getPropertyValue('--left')).toBe('1.65289256%');
    });
  });

  describe('formatClockTime', () => {
    it('shows as many fractional digits as the window needs', () => {
      const at = ORIGIN + 1234;
      expect(formatClockTime(at, 60_000, 'en')).toBe(clockReading(at, 0));
      expect(formatClockTime(at, 5_000, 'en')).toBe(clockReading(at, 1));
      expect(formatClockTime(at, 500, 'en')).toBe(clockReading(at, 2));
      expect(formatClockTime(at, 50, 'en')).toBe(clockReading(at, 3));
      expect(formatClockTime(at, 50, 'en')).toMatch(
        /^\d{2}:\d{2}:\d{2}\.\d{3}$/,
      );
    });

    it('reads the first hour after midnight as 00, not 24', () => {
      const midnight = new Date(2026, 8, 24, 0, 5, 6).getTime();
      expect(formatClockTime(midnight, 60_000, 'en')).toBe('00:05:06');
    });
  });
});
