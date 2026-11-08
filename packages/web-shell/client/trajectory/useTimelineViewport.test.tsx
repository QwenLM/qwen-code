// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TimelineModel } from './buildTimeline';
import {
  useTimelineViewport,
  type TimelineViewportController,
} from './useTimelineViewport';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLElement;
let control: TimelineViewportController;
let childView: { start: number; length: number };
function Child({
  viewportControl,
}: {
  viewportControl: TimelineViewportController;
}) {
  useLayoutEffect(() => {
    childView = viewportControl.currentView();
  }, [viewportControl]);
  return null;
}
function Fixture({ model }: { model?: TimelineModel }) {
  control = useTimelineViewport(model);
  return (
    <div data-start={control.viewport?.start} data-end={control.viewport?.end}>
      <Child viewportControl={control} />
    </div>
  );
}
function mount(model?: TimelineModel) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Fixture model={model} />));
}
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
const model: TimelineModel = {
  spans: [],
  turnMarks: [],
  mode: 'clock',
  total: 4500,
  activeMs: 2100,
  originMs: 0,
  droppedRows: 0,
};
describe('useTimelineViewport', () => {
  it('commits synchronous updates before React renders and exposes the same final viewport', () => {
    mount(model);
    act(() => {
      control.applyViewport({ start: 800, end: 1600 });
      expect(control.currentView()).toEqual({ start: 800, length: 800 });
      const previous = control.currentView();
      control.applyViewport({
        start: previous.start + 100,
        end: previous.start + previous.length + 100,
      });
      expect(control.currentView()).toEqual({ start: 900, length: 800 });
    });
    expect(control.viewport).toEqual({ start: 900, end: 1700 });
    expect(container.firstElementChild?.getAttribute('data-start')).toBe('900');
  });
  it('preserves zoom for unchanged model and immediately expires it for another snapshot', () => {
    mount(model);
    act(() => control.applyViewport({ start: 800, end: 1600 }));
    act(() => root.render(<Fixture model={model} />));
    expect(control.viewport).toEqual({ start: 800, end: 1600 });
    act(() => root.render(<Fixture model={{ ...model, total: 9000 }} />));
    expect(control.viewport).toBeUndefined();
    expect(control.currentView()).toEqual({ start: 0, length: 9000 });
    expect(childView).toEqual({ start: 0, length: 9000 });
  });
  it('resets both rendered viewport and the synchronous view', () => {
    mount(model);
    act(() => control.applyViewport({ start: 800, end: 1600 }));
    act(() => control.applyViewport(undefined));
    expect(control.viewport).toBeUndefined();
    expect(control.currentView()).toEqual({ start: 0, length: 4500 });
  });
});
