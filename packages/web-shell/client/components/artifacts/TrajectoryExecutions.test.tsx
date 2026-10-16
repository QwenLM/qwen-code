// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import type { TrajectoryExecutionRow } from '../../trajectory/project-trajectory-executions';
import { TrajectoryExecutions } from './TrajectoryExecutions';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        start: index * 34,
      })),
    getTotalSize: () => count * 34,
    scrollToIndex: vi.fn(),
  }),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const cleanup: Array<() => void> = [];
let resize: ResizeObserverCallback;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function running(key = 'a', start = 9_000): TrajectoryExecutionRow {
  return {
    key,
    name: key,
    status: 'running',
    startedAt: start,
    entry: {
      status: 'running',
      conflicted: false,
      event: {
        v: 1,
        kind: 'request',
        phase: 'started',
        executionId: key,
        sessionId: 'session',
        promptId: 'p',
        model: key,
        startedAt: start,
      },
    },
  };
}
async function mount(rows: TrajectoryExecutionRow[]) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  let alive = true;
  const unmount = () => {
    if (alive) {
      act(() => root.unmount());
      alive = false;
      container.remove();
    }
  };
  cleanup.push(unmount);
  const update = async (next: TrajectoryExecutionRow[]) => {
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <TrajectoryExecutions
            rows={next}
            omitted={0}
            incomplete={false}
            outsideWindow={0}
            onSelect={onSelect}
          />
        </I18nProvider>,
      ),
    );
  };
  await update(rows);
  return { container, onSelect, update, unmount };
}
it('owns one timer and stops it when collapsed, hidden, completed or unmounted', async () => {
  const { container, update, unmount } = await mount([running()]);
  expect(vi.getTimerCount()).toBe(1);
  expect(container.textContent).toContain('About 1.0s elapsed');
  await act(async () => vi.advanceTimersByTime(1000));
  expect(container.textContent).toContain('About 2.0s elapsed');
  act(() => container.querySelector('button')!.click());
  expect(vi.getTimerCount()).toBe(0);
  act(() => container.querySelector('button')!.click());
  expect(vi.getTimerCount()).toBe(1);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(20_000);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(vi.getTimerCount()).toBe(1);
  expect(container.textContent).toContain('About 11.0s elapsed');
  await update([{ ...running(), status: 'unknown' }]);
  expect(vi.getTimerCount()).toBe(0);
  await update([running()]);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
it('shows future starts as uncertain and terminal recorded duration without estimates', async () => {
  const { container, update } = await mount([running('future', 20_000)]);
  expect(container.textContent).toContain('Elapsed unavailable');
  expect(container.textContent).not.toContain('About -');
  await update([
    { ...running(), status: 'success', endedAt: 20_000, durationMs: 123 },
  ]);
  expect(container.textContent).toContain('123ms');
  expect(container.textContent).not.toContain('About');
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps not-started execution as a marker without zero-duration bar', async () => {
  const row: TrajectoryExecutionRow = {
    key: 'skip',
    name: 'shell',
    status: 'not_started',
    endedAt: 10_000,
    entry: {
      status: 'not_started',
      conflicted: false,
      event: {
        v: 1,
        kind: 'tool',
        phase: 'ended',
        executionId: 'skip',
        sessionId: 'session',
        callId: 'call',
        toolName: 'shell',
        executionStatus: 'not_started',
        outcome: 'cancelled',
        endedAt: 10_000,
      },
    },
  };
  const { container } = await mount([row]);
  expect(container.textContent).toContain('Not executed');
  expect(container.textContent).not.toContain('0ms');
  expect(container.querySelector('[data-marker="true"]')).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
it('selects stable execution keys with keyboard and pointer', async () => {
  const { container, onSelect } = await mount([
    running('a'),
    running('b'),
    running('c'),
  ]);
  const grid = container.querySelector('[role="grid"]')!;
  const key = (value: string) =>
    act(() => {
      grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, bubbles: true }),
      );
    });
  key('ArrowDown');
  expect(
    container
      .querySelector('[data-active="true"]')
      ?.getAttribute('data-execution-key'),
  ).toBe('b');
  expect(grid.getAttribute('aria-activedescendant')).toBe(
    container.querySelector('[data-active="true"]')?.id,
  );
  key('Enter');
  expect(onSelect).toHaveBeenLastCalledWith('b');
  key('End');
  key(' ');
  expect(onSelect).toHaveBeenLastCalledWith('c');
  key('Home');
  key('Enter');
  expect(onSelect).toHaveBeenLastCalledWith('a');
  act(() =>
    (container.querySelectorAll('[role="row"]')[1] as HTMLElement).click(),
  );
  expect(onSelect).toHaveBeenLastCalledWith('b');
});

it('opens in one click after manual collapse and a compact viewport resize', async () => {
  const { container } = await mount([running()]);
  const toggle = container.querySelector('button')!;
  act(() => toggle.click());
  act(() =>
    resize(
      [{ contentRect: { height: 400 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  act(() => toggle.click());
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(vi.getTimerCount()).toBe(1);
});
