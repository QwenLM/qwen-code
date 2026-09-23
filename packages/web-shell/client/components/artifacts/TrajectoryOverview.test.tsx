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
    act(() => spans[2]!.click());
    expect(onSelect).toHaveBeenCalledWith('sub');
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
