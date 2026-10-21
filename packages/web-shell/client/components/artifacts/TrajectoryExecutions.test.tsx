// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { act, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    scrollToOffset: vi.fn(),
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
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(136);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return (
        Number.parseFloat(
          (this.firstElementChild as HTMLElement | null)?.style.height ?? '0',
        ) || 0
      );
    },
  );
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
type FeedOptions = Pick<
  ComponentProps<typeof TrajectoryExecutions>,
  'liveStatus' | 'historySnapshot'
>;
function FollowHarness({
  rows,
  onSelect,
  options,
  onPause,
  onReturn,
  onFocusLost,
}: {
  rows: TrajectoryExecutionRow[];
  onSelect: (key: string) => void;
  options: FeedOptions;
  onPause: () => void;
  onReturn: () => void;
  onFocusLost: () => void;
}) {
  const [following, setFollowing] = useState(true);
  const [updated, setUpdated] = useState(false);
  // The follow controls live in the panel's summary bar; this stands in for
  // them, after the section so the section's toggle stays the first button.
  return (
    <>
      <TrajectoryExecutions
        rows={rows}
        onSelect={onSelect}
        {...options}
        following={following}
        onPause={() => {
          setFollowing(false);
          onPause();
        }}
        onUpdatedChange={setUpdated}
        onFocusLost={onFocusLost}
      />
      <span>
        {following
          ? options.liveStatus === 'live'
            ? 'Following'
            : 'Waiting for live updates'
          : 'Paused'}
        {updated && !following ? ' · Execution list updated' : ''}
      </span>
      <button
        type="button"
        data-testid="trajectory-follow-pause"
        onClick={() => {
          if (!following) return;
          setFollowing(false);
          onPause();
        }}
      >
        Pause
      </button>
      <button
        type="button"
        data-testid="trajectory-follow-return"
        onClick={() => {
          setFollowing(true);
          onReturn();
        }}
      >
        Return to latest
      </button>
    </>
  );
}
async function mount(rows: TrajectoryExecutionRow[], shadow = false) {
  const container = document.createElement('div');
  const host = shadow ? document.createElement('div') : container;
  document.body.append(host);
  if (shadow) host.attachShadow({ mode: 'open' }).append(container);
  const root = createRoot(container);
  const onSelect = vi.fn();
  const onPause = vi.fn();
  const onReturn = vi.fn();
  const onFocusLost = vi.fn();
  let options: FeedOptions = { liveStatus: 'live', historySnapshot: undefined };
  let alive = true;
  const unmount = () => {
    if (alive) {
      act(() => root.unmount());
      alive = false;
      host.remove();
    }
  };
  cleanup.push(unmount);
  const update = async (
    next: TrajectoryExecutionRow[],
    extra: Partial<FeedOptions> = {},
  ) => {
    options = { ...options, ...extra };
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <FollowHarness
            rows={next}
            onSelect={onSelect}
            options={options}
            onPause={onPause}
            onReturn={onReturn}
            onFocusLost={onFocusLost}
          />
        </I18nProvider>,
      ),
    );
  };
  await update(rows);
  return {
    container,
    onSelect,
    onPause,
    onReturn,
    onFocusLost,
    update,
    unmount,
  };
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

it('watches the panel height once the first execution arrives', async () => {
  resize = undefined as unknown as ResizeObserverCallback;
  const { container, update } = await mount([]);
  expect(resize).toBeUndefined();
  await update([running()]);
  act(() =>
    resize(
      [{ contentRect: { height: 400 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe(
    'false',
  );
});

it('anchors a paused reader across insertion, reordering, collapse and eviction', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => running(String(index)));
  const { container, update, onPause } = await mount(rows);
  const grid = () => container.querySelector<HTMLElement>('[role="grid"]')!;
  act(() => {
    grid().scrollTop = 5 * 34 + 7;
    grid().dispatchEvent(new Event('scroll'));
  });
  expect(container.textContent).toContain('Paused');
  onPause.mockClear();
  await update([running('new'), ...rows]);
  expect(grid().scrollTop).toBe(6 * 34 + 7);
  act(() => grid().dispatchEvent(new Event('scroll')));
  expect(onPause).not.toHaveBeenCalled();
  expect(container.textContent).toContain('Execution list updated');
  const reordered = [rows[20]!, ...rows.filter((row) => row !== rows[20])];
  await update(reordered);
  expect(grid().scrollTop).toBe(6 * 34 + 7);
  act(() => container.querySelector<HTMLButtonElement>('button')!.click());
  await update([running('another'), ...reordered]);
  act(() => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(grid().scrollTop).toBe(7 * 34 + 7);
  await update(reordered.filter((row) => row.key !== '5'));
  // The next old neighbor (6) takes the first visible position.
  expect(grid().scrollTop).toBe(6 * 34 + 7);
  const button = container.querySelector<HTMLButtonElement>(
    '[data-testid="trajectory-follow-return"]',
  )!;
  act(() => {
    button.focus();
    button.click();
  });
  expect(grid().scrollTop).toBe(0);
  expect(document.activeElement).toBe(button);
  expect(container.textContent).not.toContain('Execution list updated');
});

it.each([false, true])(
  'returns to the top once without live delivery (collapsed=%s)',
  async (collapsed) => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      running(String(index)),
    );
    const { container, update } = await mount(rows);
    const grid = () => container.querySelector<HTMLElement>('[role="grid"]')!;
    act(() => {
      grid().scrollTop = 600;
      grid().dispatchEvent(new Event('scroll'));
    });
    await update(rows, { liveStatus: 'unavailable' });
    const toggle = container.querySelector<HTMLButtonElement>('button')!;
    if (collapsed) act(() => toggle.click());
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="trajectory-follow-return"]',
    )!;
    act(() => {
      button.focus();
      button.click();
    });
    expect(container.textContent).toContain('Waiting for live updates');
    if (collapsed) act(() => toggle.click());
    expect(grid().scrollTop).toBe(0);
    expect(document.activeElement).toBe(button);
    await update([running('replayed'), ...rows], { liveStatus: 'catching-up' });
    expect(grid().scrollTop).toBe(34);
  },
);

it('does not treat reconnect or history replacement as new live executions', async () => {
  const { container, update } = await mount([running('a')]);
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="trajectory-follow-pause"]',
      )!
      .click(),
  );
  await update([running('b'), running('a')]);
  expect(container.textContent).toContain('Execution list updated');
  await update([running('b'), running('a')], { liveStatus: 'catching-up' });
  await update([running('replay'), running('b'), running('a')], {
    liveStatus: 'live',
  });
  expect(container.textContent).not.toContain('Execution list updated');
  await update([running('history'), running('replay')], {
    historySnapshot: {},
  });
  expect(container.textContent).not.toContain('Execution list updated');
  await update([running('live'), running('history'), running('replay')]);
  expect(container.textContent).toContain('Execution list updated');
});

it('renders nothing while empty and counts the first execution as new', async () => {
  const { container, update } = await mount([]);
  expect(
    container.querySelector('[data-testid="trajectory-executions"]'),
  ).toBeNull();
  act(() =>
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid="trajectory-follow-pause"]',
      )!
      .click(),
  );
  await update([running('first')]);
  expect(
    container.querySelector('[data-testid="trajectory-executions"]'),
  ).not.toBeNull();
  expect(container.textContent).toContain('Execution list updated');
});

it('restores the paused anchor after CSS hiding resets the DOM offset', async () => {
  const { container } = await mount(
    Array.from({ length: 40 }, (_, index) => running(String(index))),
  );
  const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
  act(() => {
    grid.scrollTop = 347;
    grid.dispatchEvent(new Event('scroll'));
  });
  const height = vi.spyOn(grid, 'clientHeight', 'get').mockReturnValue(0);
  act(() => {
    grid.scrollTop = 0;
    grid.dispatchEvent(new Event('scroll'));
  });
  height.mockReturnValue(136);
  act(() =>
    resize(
      [{ contentRect: { height: 700 } } as ResizeObserverEntry],
      {} as ResizeObserver,
    ),
  );
  expect(grid.scrollTop).toBe(347);
  act(() => vi.advanceTimersByTime(20));
  expect(grid.scrollTop).toBe(347);
});

it('pauses before keyboard reading and keeps the active key when rows reorder', async () => {
  const { container, update, onPause, onSelect } = await mount([
    running('a'),
    running('b'),
  ]);
  const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
  act(() =>
    grid.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
    ),
  );
  expect(onPause).toHaveBeenCalled();
  await update([running('new'), running('b'), running('a')]);
  act(() =>
    grid.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    ),
  );
  expect(onSelect).toHaveBeenLastCalledWith('b');
  expect(container.textContent).toContain('Paused');
});

describe.each([false, true])('focus recovery (shadow=%s)', (shadow) => {
  for (const removal of ['compact', 'empty'] as const) {
    it.each([false, true])(
      `restores focus on ${removal} only when the removed grid owns it (outside=%s)`,
      async (outside) => {
        const { container, update, onFocusLost } = await mount(
          [running()],
          shadow,
        );
        const grid = container.querySelector<HTMLElement>('[role="grid"]')!;
        const toggle = container.querySelector<HTMLButtonElement>('button')!;
        const other = document.createElement('button');
        container.append(other);
        (outside ? other : grid).focus();
        if (removal === 'compact') {
          await act(async () =>
            resize(
              [{ contentRect: { height: 400 } } as ResizeObserverEntry],
              {} as ResizeObserver,
            ),
          );
        } else {
          await update([]);
        }
        expect(container.querySelector('[role="grid"]')).toBeNull();
        // An empty strip renders nothing, so its owner is asked to take focus.
        const lost = removal === 'empty' && !outside;
        if (!lost) {
          expect(
            (container.getRootNode() as Document | ShadowRoot).activeElement,
          ).toBe(outside ? other : toggle);
        }
        expect(onFocusLost).toHaveBeenCalledTimes(lost ? 1 : 0);
      },
    );
  }
});
