// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { TrajectoryPanel } from './TrajectoryPanel';
import type {
  TrajectoryPageLoader,
  TrajectoryPageResult,
} from '../../trajectory/useTrajectoryWindow';
import transcriptPage from '../../trajectory/__fixtures__/transcript-page.json' with { type: 'json' };

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** One page of a real `qwen serve` session; see the projection tests. */
const REAL_EVENTS = transcriptPage.events as unknown as DaemonEvent[];

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

// The virtualizer sizes its viewport from `offsetHeight`, which jsdom reports
// as zero for every element. Without a stubbed box it would mount no rows and
// every assertion about the table would pass vacuously.
const VIEWPORT_HEIGHT = 900;
/** Matches the panel's own uniform row height; the prepend correction is
 * arithmetic on it, so a test that asserts the offset has to know it. */
const ROW_HEIGHT = 34;
const BOX_PROPS = ['offsetHeight', 'offsetWidth'] as const;
const originalBoxes = new Map<string, PropertyDescriptor | undefined>();
// jsdom performs no layout, so its own `scrollTop` is pinned at 0 and an
// offset the panel puts back would be unobservable. Backing it with real
// storage is what lets the restore be asserted at all.
const scrollTops = new WeakMap<HTMLElement, number>();
let originalScrollTop: PropertyDescriptor | undefined;
// Same reason as `scrollTop`: jsdom reports zero content height, which would
// make "opened at the bottom" and "never scrolled" the same observation.
const SCROLL_HEIGHT = 4000;
let originalScrollHeight: PropertyDescriptor | undefined;

beforeAll(() => {
  originalScrollTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollTop',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      scrollTops.set(this, value);
    },
  });
  originalScrollHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight',
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => SCROLL_HEIGHT,
  });
  for (const prop of BOX_PROPS) {
    originalBoxes.set(
      prop,
      Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop),
    );
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get: () => (prop === 'offsetHeight' ? VIEWPORT_HEIGHT : 600),
    });
  }
});

afterAll(() => {
  if (originalScrollTop) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollTop',
      originalScrollTop,
    );
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
      'scrollTop'
    ];
  }
  if (originalScrollHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollHeight',
      originalScrollHeight,
    );
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
      'scrollHeight'
    ];
  }
  for (const [prop, descriptor] of originalBoxes) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, prop, descriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
        prop
      ];
    }
  }
});

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.length = 0;
  vi.clearAllMocks();
});

async function render(
  loadPage: TrajectoryPageLoader | undefined,
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <TrajectoryPanel loadPage={loadPage} />
      </I18nProvider>,
    );
  });
  return container;
}

function page(
  events: readonly DaemonEvent[],
  extra: Partial<TrajectoryPageResult> = {},
): TrajectoryPageResult {
  return { events, hasMore: false, ...extra };
}

function userText(text: string, recordId: string): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      _meta: {
        qwenTranscript: {
          sourceRecordIds: [recordId],
          segmentId: `${recordId}:0`,
        },
        'qwen.session.recordId': recordId,
      },
    },
  } as unknown as DaemonEvent;
}

function toolCall(
  callId: string,
  toolName: string,
  title: string,
  recordId: string,
): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'tool_call',
      toolCallId: callId,
      title,
      status: 'completed',
      rawInput: { path: 'note.txt' },
      _meta: {
        qwenTranscript: { sourceRecordIds: [recordId] },
        'qwen.session.recordId': recordId,
        qwenToolName: toolName,
      },
    },
  } as unknown as DaemonEvent;
}

function timingFrame(
  timing: Record<string, unknown>,
  recordId: string,
): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: { timing, 'qwen.session.recordId': recordId },
    },
  } as unknown as DaemonEvent;
}

const text = (element: Element | null) => element?.textContent ?? '';
const rowsOf = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[role="row"]'));
const metricsOf = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll('[data-testid="trajectory-row-metrics"]'),
  ).map((node) => node.textContent ?? '');

describe('TrajectoryPanel', () => {
  it('folds a real page into turns, requests and tools', async () => {
    const container = await render(async () => page(REAL_EVENTS));

    expect(
      text(container.querySelector('[data-testid="trajectory-totals"]')),
    ).toContain('1 turn ·');
    expect(
      container.querySelectorAll('[data-testid="trajectory-turn"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="trajectory-row-request"]')
        .length,
    ).toBeGreaterThan(0);
    // The real page's first round took 7.8s with a 2.4s TTFT; both come off
    // the recorded frame rather than any client clock.
    const body = container.textContent ?? '';
    expect(body).toContain('7.8s');
    expect(body).toContain('TTFT');
  });

  it('shows a dash where no duration was recorded', async () => {
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        toolCall('call-1', 'read_file', 'ReadFile: note.txt', 'rec-2'),
      ]),
    );

    // An in-flight call, or a session older than timing frames, has no
    // duration to show — and none is invented from arrival times.
    expect(metricsOf(container)).toContain('—');
    expect(container.textContent).not.toContain('0ms');
    expect(container.textContent).not.toContain('NaN');
  });

  it('says so when the window holds no recorded timing', async () => {
    const container = await render(async () => page([userText('go', 'rec-1')]));

    expect(container.textContent).toContain(
      'No request or tool durations are recorded',
    );
  });

  it('counts a tool duration as recorded timing', async () => {
    // A window can hold a timed tool call with no request frame in it, when the
    // page starts after the round's telemetry record. That is timing, so the
    // notice must stay away.
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        toolCall('call-1', 'read_file', 'Read note.txt', 'rec-2'),
        timingFrame(
          {
            kind: 'tool',
            durationMs: 120,
            callId: 'call-1',
            toolName: 'read_file',
          },
          'rec-3',
        ),
      ]),
    );

    expect(container.textContent).not.toContain(
      'No request or tool durations are recorded',
    );
  });

  it('marks a failed request', async () => {
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        timingFrame(
          { kind: 'request', durationMs: 400, status: 'error' },
          'rec-2',
        ),
      ]),
    );

    expect(container.textContent).toContain('Request failed');
  });

  it('says a request failed even when it names its model', async () => {
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        timingFrame(
          {
            kind: 'request',
            durationMs: 400,
            status: 'error',
            model: 'qwen3-coder-plus',
          },
          'rec-2',
        ),
      ]),
    );

    // Which is the ordinary case: a failed round still reports its model, and
    // the red badge alone does not reach a reader who cannot see colour.
    expect(container.textContent).toContain('qwen3-coder-plus');
    expect(container.textContent).toContain('Request failed');
  });

  it('reports a page it could not read and offers a retry', async () => {
    let fail = true;
    const loadPage = vi.fn(async () =>
      fail
        ? page([], { replayError: 'Replay conversion failed for this page' })
        : page([userText('recovered', 'rec-1')]),
    );
    const container = await render(loadPage);

    const alert = container.querySelector('[role="alert"]');
    expect(text(alert)).toContain('Replay conversion failed');

    fail = false;
    await act(async () =>
      (alert!.querySelector('button') as HTMLButtonElement).click(),
    );
    expect(container.textContent).toContain('recovered');
  });

  it('renders a loading state until the first page lands', async () => {
    let release!: (value: TrajectoryPageResult) => void;
    const pending = new Promise<TrajectoryPageResult>((resolve) => {
      release = resolve;
    });
    const container = await render(async () => pending);

    expect(text(container.querySelector('[role="status"]'))).toContain(
      'Loading',
    );
    await act(async () => {
      release(page([userText('done', 'rec-1')]));
    });
    expect(container.textContent).toContain('done');
  });

  it('renders an empty session without a grid', async () => {
    const container = await render(async () => page([]));

    expect(text(container.querySelector('[role="status"]'))).toContain(
      'No records',
    );
    expect(container.querySelector('[role="grid"]')).toBeNull();
  });

  it('waits for a loader instead of fetching without one', async () => {
    const container = await render(undefined);

    expect(container.querySelector('[role="grid"]')).toBeNull();
    expect(
      (
        container.querySelector(
          'button[aria-label="Refresh"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('moves the selection with the arrow keys', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    const press = async (key: string) => {
      await act(async () => {
        grid.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
    };
    const selectedIndex = () =>
      rowsOf(container).findIndex((row) =>
        Boolean(row.querySelector('[data-selected="true"]')),
      );

    // Starts at the top rather than wherever the pointer last was, so the
    // first keypress is predictable.
    await press('ArrowDown');
    expect(selectedIndex()).toBe(0);
    await press('ArrowDown');
    expect(selectedIndex()).toBe(1);
    await press('ArrowUp');
    expect(selectedIndex()).toBe(0);

    await press('End');
    expect(selectedIndex()).toBe(rowsOf(container).length - 1);
    await press('Home');
    expect(selectedIndex()).toBe(0);
    expect(container.querySelectorAll('[data-selected="true"]')).toHaveLength(
      1,
    );
  });

  it('names a subagent whose spawning call is outside the window', async () => {
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        timingFrame(
          {
            kind: 'request',
            durationMs: 5600,
            status: 'ok',
            subagentId: 'general-purpose-call_09f25abe46e242ad951ba028',
            promptId: 's#general-purpose-call_09f25abe46e242ad951ba028#0',
          },
          'rec-2',
        ),
      ]),
    );

    // Forty characters of hex in the name column tells a reader nothing; the
    // trailing call id is recognisable as an id, so only the type is shown.
    expect(container.textContent).toContain('general-purpose');
    expect(container.textContent).not.toContain('call_09f25abe');
  });

  it('shows a subagent id whole when its tail is not a call id', async () => {
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        timingFrame(
          {
            kind: 'request',
            durationMs: 900,
            status: 'ok',
            subagentId: 'memory-extractor',
            promptId: 's#memory-extractor#0',
          },
          'rec-2',
        ),
      ]),
    );

    expect(container.textContent).toContain('memory-extractor');
  });

  it('names a partial page instead of quoting the flag', async () => {
    const container = await render(async () =>
      page([], { partial: true as const }),
    );

    const alert = container.querySelector('[role="alert"]');
    // Its own sentence, not the one written for a restored right-panel tab:
    // what failed here is a transcript read, and saying otherwise tells the
    // reader their saved panel content is gone when it is not.
    expect(text(alert)).toContain('Part of this transcript could not be read');
    expect(text(alert)).not.toContain('Saved panel content');
    expect(container.textContent).not.toContain(': partial');
  });

  it('keeps the grid the only tab stop, so a click cannot outrank the selection', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    // Nothing inside the grid takes focus of its own. A focusable row would
    // let DOM focus and the selection point at different rows, and would be a
    // second tab stop inside a list that can run to hundreds of them.
    expect(
      container.querySelector('button[data-testid="trajectory-turn"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[role="grid"] button, [role="grid"] a'),
    ).toHaveLength(0);
    expect(grid.getAttribute('tabindex')).toBe('0');

    // Clicking hands focus back, so the arrow keys keep working afterwards.
    const rows = () =>
      Array.from(
        container.querySelectorAll('[data-testid^="trajectory-row-"]'),
      ) as HTMLElement[];
    const clicked = rows()[1]!;
    await act(async () => clicked.click());
    expect(document.activeElement).toBe(grid);
    // The row the assistive technology is told about is the row under the
    // pointer, so focus and the selection cannot name different rows.
    expect(grid.getAttribute('aria-activedescendant')).toBe(
      clicked.closest('[role="row"]')!.id,
    );
  });

  it('opens on the newest turn rather than the oldest', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const scroll = container.querySelector('[role="grid"]') as HTMLElement;

    // The newest turn is the one the reader just watched run, so the tail is
    // what the panel has to be showing when it appears.
    expect(scroll.scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('puts the reader back where they were when the box is resized', async () => {
    const callbacks = new Set<ResizeObserverCallback>();
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        callbacks.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        callbacks.delete(this.callback);
      }
    } as unknown as typeof ResizeObserver;
    try {
      const container = await render(async () => page(REAL_EVENTS));
      const scroll = container.querySelector('[role="grid"]') as HTMLElement;
      await act(async () => {
        scroll.scrollTop = 400;
        scroll.dispatchEvent(new Event('scroll'));
      });

      // Hiding the box — which is what the right panel's fullscreen toggle
      // does on its way through — zeroes the offset without a scroll event,
      // leaving the virtualizer rendering rows for an offset nobody is at.
      scroll.scrollTop = 0;
      await act(async () => {
        for (const callback of callbacks) {
          callback([], undefined as unknown as ResizeObserver);
        }
      });

      expect(scroll.scrollTop).toBe(400);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  it('shows what an other-kind row actually says', async () => {
    const container = await render(async () =>
      page([
        userText('go', 'rec-1'),
        {
          v: 1,
          type: 'session_update',
          data: {
            sessionUpdate: 'shell_output',
            stream: 'stdout',
            content: { type: 'text', text: 'build finished in 4s' },
            _meta: { 'qwen.session.recordId': 'rec-2' },
          },
        } as unknown as DaemonEvent,
      ]),
    );

    // A lowercase discriminator in the gutter with an empty label beside it
    // tells the reader nothing the row itself could have said.
    expect(container.textContent).toContain('build finished in 4s');
    expect(container.textContent).not.toContain('shell_output');
  });

  it('offers older history only while the window has room', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0')])
        : page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const container = await render(loadPage);

    const older = container.querySelector(
      '[data-testid="trajectory-load-older"]',
    ) as HTMLButtonElement;
    expect(older).not.toBeNull();
    await act(async () => older.click());

    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="trajectory-load-older"]'),
    ).toBeNull();
    expect(container.textContent).toContain('older');
    expect(container.textContent).toContain('newest');
  });

  it('offers the way back when the newest page folds to nothing', async () => {
    // A page can carry records that project to no rows at all — telemetry the
    // fold drops, or updates this view does not keep — while still reporting
    // history behind it. The button is the only way to that history, so it
    // cannot be conditioned on the table having rows.
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0')])
        : page([], { hasMore: true, nextCursor: 'older-1' }),
    );
    const container = await render(loadPage);

    expect(
      container.querySelector('[data-testid="trajectory-load-older"]'),
    ).not.toBeNull();

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );

    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('older');
  });

  it('holds the older bar in place once the walk has reached the start', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0')])
        : page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const container = await render(loadPage);
    const bar = container.querySelector('[class*="olderBar"]');
    expect(bar).not.toBeNull();

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );

    // The rows below the bar are `flex: 1`, so unmounting it when the last
    // page lands would grow them upward by its height and move the row the
    // reader is on — the same displacement paging corrects for. The button
    // gives way to a notice; the bar itself stays.
    const after = container.querySelector('[class*="olderBar"]');
    expect(after).not.toBeNull();
    expect(after).toBe(bar);
    expect(
      container.querySelector('[data-testid="trajectory-load-older"]'),
    ).toBeNull();
    expect(after?.textContent).toContain('start of the session');
  });

  it('keeps the reader on the same row when an older page lands', async () => {
    const older = [
      userText('older one', 'rec-0'),
      userText('older two', 'rec--1'),
    ];
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page(older)
        : page([userText('newest', 'rec-1')], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const container = await render(loadPage);
    const scroll = container.querySelector('[role="grid"]') as HTMLElement;
    scroll.scrollTop = 120;
    const before = rowsOf(container).length;

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );

    // Everything already on screen moved down by exactly the rows that were
    // added, so the offset moves with it and the reader does not lose place.
    const added = rowsOf(container).length - before;
    expect(added).toBeGreaterThan(0);
    expect(scroll.scrollTop).toBe(120 + added * ROW_HEIGHT);
  });

  it('does not move the view when a later read lengthens the list', async () => {
    let rows = [userText('one', 'rec-1')];
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) => {
      if (opts.cursor) throw new Error('older page is unreadable');
      return page(rows, { hasMore: true, nextCursor: 'older-1' });
    });
    const container = await render(loadPage);
    const scroll = container.querySelector('[role="grid"]') as HTMLElement;

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );
    scroll.scrollTop = 80;

    rows = [userText('one', 'rec-1'), userText('two', 'rec-2')];
    await act(async () =>
      (
        container.querySelector('[aria-label="Refresh"]') as HTMLButtonElement
      ).click(),
    );

    // The failed load added no page, so the correction must not fire on the
    // next thing that lengthens the list.
    expect(rowsOf(container).length).toBeGreaterThan(1);
    expect(scroll.scrollTop).toBe(80);
  });

  it('retries the page that failed instead of rebuilding from the newest', async () => {
    let olderCalls = 0;
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) => {
      if (!opts.cursor) {
        return page([userText('newest', 'rec-1')], {
          hasMore: true,
          nextCursor: 'older-1',
        });
      }
      olderCalls += 1;
      return olderCalls === 1
        ? page([], { replayError: 'flaky' })
        : page([userText('older', 'rec-0')], { hasMore: false });
    });
    const container = await render(loadPage);
    const older = () =>
      container.querySelector(
        '[data-testid="trajectory-load-older"]',
      ) as HTMLButtonElement | null;

    await act(async () => older()!.click());
    expect(text(container.querySelector('[role="alert"]'))).toContain('flaky');

    await act(async () =>
      (
        container.querySelector('[role="alert"] button') as HTMLButtonElement
      ).click(),
    );

    // The retry re-read the cursor rather than the newest page, so the pages
    // already paged back through are still here — a rebuild would have thrown
    // them away and put the reader back at the end.
    expect(loadPage.mock.calls.filter(([opts]) => opts.cursor).length).toBe(2);
    expect(loadPage.mock.calls.filter(([opts]) => !opts.cursor).length).toBe(1);
    expect(container.textContent).toContain('older');
    expect(container.textContent).toContain('newest');
  });

  it('does not offer history the page gave no cursor for', async () => {
    const container = await render(async () =>
      // `hasMore` without a cursor is history this view cannot reach; offering
      // it would be a button that does nothing at all when pressed.
      page([userText('only', 'rec-1')], { hasMore: true }),
    );

    expect(
      container.querySelector('[data-testid="trajectory-load-older"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain('beyond the window');
  });

  it('keeps the load-older control out of the scrolled rows', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0')])
        : page(REAL_EVENTS, { hasMore: true, nextCursor: 'older-1' }),
    );
    const container = await render(loadPage);
    const scroll = container.querySelector('[role="grid"]') as HTMLElement;
    const older = container.querySelector(
      '[data-testid="trajectory-load-older"]',
    ) as HTMLButtonElement;

    // Inside the scrolled box its height would offset every virtual row from
    // the coordinates the virtualizer hands out, and the bar vanishing with
    // the last page would move the rows again on top of the prepend
    // correction.
    expect(older).not.toBeNull();
    expect(scroll.contains(older)).toBe(false);
    expect(scroll.children).toHaveLength(1);
  });

  it('numbers rows by their place in the whole table, not in the DOM', async () => {
    // Forty prompts fold to forty turns of a header and a user row each: more
    // rows than the viewport mounts, so the count and the indexes have to come
    // from the table rather than from what happens to be rendered.
    const prompts = Array.from({ length: 40 }, (_unused, index) =>
      userText(`prompt ${index + 1}`, `rec-${index + 1}`),
    );
    const container = await render(async () => page(prompts));
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    const rendered = rowsOf(container);

    expect(Number(grid.getAttribute('aria-rowcount'))).toBe(80);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(80);
    const indexes = rendered.map((row) =>
      Number(row.getAttribute('aria-rowindex')),
    );
    expect(indexes[0]).toBeGreaterThanOrEqual(1);
    expect(indexes.at(-1)).toBeLessThanOrEqual(80);
    expect(indexes).toEqual(
      indexes.map((_value, offset) => indexes[0]! + offset),
    );
  });
});
