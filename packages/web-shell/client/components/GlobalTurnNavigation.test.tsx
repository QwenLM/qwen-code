// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { createDaemonTurnNavigationStore } from '../daemon/session/turn-navigation-store';
import { GlobalTurnNavigation } from './GlobalTurnNavigation';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, values?: { index: number }) =>
      values ? `Turn ${values.index}` : key,
  }),
}));
let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function tailPages(count: number) {
  const start = Math.max(0, count - 200);
  return new Map(
    count
      ? [
          [
            start,
            {
              start,
              end: count,
              snapshot: 'tail-snapshot',
              retainedBytes: 100,
              turns: Array.from({ length: count - start }, (_, index) => ({
                ordinal: start + index,
                turnId: `turn-${start + index}`,
                kind: 'prompt' as const,
                label: `Turn ${start + index + 1}`,
              })),
            },
          ],
        ]
      : [],
  );
}

async function setup(count = 5000, cachedTail = true) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const store = createDaemonTurnNavigationStore();
  const state = {
    ...store.getSnapshot(),
    sessionId: 'session',
    mode: 'ready' as const,
    totalTurns: count,
    effectiveTurnCount: count,
    indexPages: tailPages(cachedTail ? count : 0),
  };
  const load = vi.spyOn(store, 'loadOrdinal').mockResolvedValue();
  const select = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <GlobalTurnNavigation state={state} store={store} onSelect={select} />,
    ),
  );
  return { load, select, state, store };
}

it('keeps a keyboard entry point when a rewind reduces the turn count', async () => {
  const { state, store, select } = await setup();
  await act(async () =>
    root.render(
      <GlobalTurnNavigation
        state={{ ...state, totalTurns: 10, effectiveTurnCount: 10 }}
        store={store}
        onSelect={select}
      />,
    ),
  );
  expect(
    container
      .querySelector('[data-turn-ordinal="9"]')
      ?.getAttribute('tabindex'),
  ).toBe('0');
});

it('keeps a Tab entry after scrolling the focused turn out of the virtual window', async () => {
  await setup();
  const scroll = container.querySelector<HTMLElement>('nav > div')!;
  await act(async () => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(container.querySelector('[data-turn-ordinal="4999"]')).toBeNull();
  expect(
    container.querySelector('[data-turn-ordinal][tabindex="0"]'),
  ).not.toBeNull();
});

it('waits for Retry after a metadata failure even when the store republishes its index map', async () => {
  const { state, store, select, load } = await setup();
  load.mockClear().mockRejectedValue(new Error('offline'));
  const scroll = container.querySelector<HTMLElement>('nav > div')!;
  await act(async () => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(
      <GlobalTurnNavigation
        state={{ ...state, indexPages: new Map() }}
        store={store}
        onSelect={select}
      />,
    ),
  );
  expect(load).toHaveBeenCalledTimes(1);
  const retry = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'history.retry',
  )!;
  expect(retry).toBeDefined();
  await act(async () => retry.click());
  expect(load).toHaveBeenCalledTimes(2);
});

it('represents all turns while bounding DOM rows and loading only visible metadata', async () => {
  const { load } = await setup();
  expect(container.querySelectorAll('[data-turn-ordinal]').length).toBeLessThan(
    40,
  );
  expect(container.querySelector('[aria-setsize="5000"]')).not.toBeNull();
  expect(container.querySelector('[data-turn-ordinal="4999"]')).not.toBeNull();
  expect(load).not.toHaveBeenCalled();
});

it('initializes an empty session at its cached tail when the count arrives', async () => {
  const { state, store, select, load } = await setup(0);
  expect(load).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <GlobalTurnNavigation
        state={{
          ...state,
          totalTurns: 5000,
          effectiveTurnCount: 5000,
          indexPages: tailPages(5000),
        }}
        store={store}
        onSelect={select}
      />,
    ),
  );
  expect(container.querySelector('[data-turn-ordinal="4999"]')).not.toBeNull();
  expect(load).not.toHaveBeenCalled();
});

it.each([5000, 10000])(
  'initializes a different %i-turn session at its tail without loading the prior viewport',
  async (count) => {
    const { state, store, select, load } = await setup();
    const scroll = container.querySelector<HTMLElement>('nav > div')!;
    await act(async () => {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll'));
    });
    load.mockClear();
    await act(async () =>
      root.render(
        <GlobalTurnNavigation
          state={{
            ...state,
            sessionId: 'next-session',
            totalTurns: count,
            effectiveTurnCount: count,
            indexPages: tailPages(count),
          }}
          store={store}
          onSelect={select}
        />,
      ),
    );
    expect(
      container.querySelector(`[data-turn-ordinal="${count - 1}"]`),
    ).not.toBeNull();
    expect(load).not.toHaveBeenCalled();
  },
);

it('loads the displayed tail metadata when it is missing', async () => {
  const { load } = await setup(5000, false);
  expect(container.querySelector('[data-turn-ordinal="4999"]')).not.toBeNull();
  expect(load).toHaveBeenCalledExactlyOnceWith(4800);
});

it('loads the first page on demand when the reader scrolls there', async () => {
  const { load } = await setup();
  load.mockClear();
  const scroll = container.querySelector<HTMLElement>('nav > div')!;
  await act(async () => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event('scroll'));
  });
  expect(load).toHaveBeenCalledExactlyOnceWith(0);
});

it('moves keyboard focus to unloaded first and last turns and selects on click', async () => {
  const { select, load } = await setup();
  load.mockClear();
  const last = container.querySelector<HTMLButtonElement>(
    '[data-turn-ordinal="4999"]',
  )!;
  await act(async () =>
    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    ),
  );
  const first = container.querySelector<HTMLButtonElement>(
    '[data-turn-ordinal="0"]',
  )!;
  expect(document.activeElement).toBe(first);
  await act(async () => first.click());
  expect(select).toHaveBeenLastCalledWith(0);
  expect(load).toHaveBeenCalledExactlyOnceWith(0);
  await act(async () =>
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    ),
  );
  expect(document.activeElement?.getAttribute('data-turn-ordinal')).toBe(
    '4999',
  );
});

it('shows a preview on keyboard focus while the tick stays text-free', async () => {
  const { state, store, select, load } = await setup();
  const entry = {
    ordinal: 4999,
    turnId: 'last',
    kind: 'prompt' as const,
    label: 'Review the change',
    detail: 'The change preserves continuous scrolling.',
  };
  await act(async () =>
    root.render(
      <GlobalTurnNavigation
        state={{
          ...state,
          indexPages: new Map([
            [
              4800,
              {
                start: 4800,
                end: 5000,
                snapshot: 's',
                retainedBytes: 100,
                turns: [entry],
              },
            ],
          ]),
        }}
        store={store}
        onSelect={select}
      />,
    ),
  );
  const button = container.querySelector<HTMLButtonElement>(
    '[data-turn-ordinal="4999"]',
  )!;
  expect(button.textContent).toBe('');
  expect(button.getAttribute('aria-label')).toContain(entry.label);
  const requestsBeforeFocus = load.mock.calls.length;
  await act(async () => button.focus());
  const tooltip = document.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toContain(entry.label);
  expect(tooltip?.textContent).toContain(entry.detail);
  expect(load.mock.calls.length).toBe(requestsBeforeFocus);
  await act(async () =>
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
