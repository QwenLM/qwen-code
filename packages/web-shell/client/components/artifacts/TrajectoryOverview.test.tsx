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

function render(props: Partial<TrajectoryOverviewProps>): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  act(() => {
    root.render(
      <I18nProvider language="en">
        <TrajectoryOverview
          model={undefined}
          onSelect={() => {}}
          onRangeChange={() => {}}
          describe={(span) => `about ${span.rowKey}`}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
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
  total: 2000,
  droppedRows: 0,
};

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
      // A right press starts no gesture of its own.
      pointer(plot, 'pointerdown', at(0.5), 2);
      pointer(plot, 'pointerup', at(0.5), 2);
      expect(onRangeChange).not.toHaveBeenCalled();
      const menu = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        plot.dispatchEvent(menu);
      });
      expect(menu.defaultPrevented).toBe(true);
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
});
