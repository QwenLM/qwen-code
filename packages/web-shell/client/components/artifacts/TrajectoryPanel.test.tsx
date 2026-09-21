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
const ROW_HEIGHT = 34;
const BOX_PROPS = ['offsetHeight', 'offsetWidth'] as const;
const originalBoxes = new Map<string, PropertyDescriptor | undefined>();
// jsdom performs no layout, so its own `scrollTop` is pinned at 0 and the
// prepend correction would be unobservable. Backing it with real storage is
// what lets the scroll arithmetic be asserted at all.
const scrollTops = new WeakMap<HTMLElement, number>();
let originalScrollTop: PropertyDescriptor | undefined;

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
  options?: { pageSize?: number; maxPages?: number },
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <TrajectoryPanel loadPage={loadPage} windowOptions={options} />
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

  it('says so when the session predates timing frames', async () => {
    const container = await render(async () => page([userText('go', 'rec-1')]));

    expect(container.textContent).toContain(
      'written before per-request timing',
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

  it('collapses a turn down to its header and expands it again', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const before = rowsOf(container).length;
    expect(before).toBeGreaterThan(1);

    const header = container.querySelector(
      '[data-testid="trajectory-turn"]',
    ) as HTMLButtonElement;
    await act(async () => header.click());
    expect(rowsOf(container)).toHaveLength(1);
    expect(header.getAttribute('aria-expanded')).toBe('false');

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-turn"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(rowsOf(container).length).toBe(before);
  });

  it('keeps a turn collapsed across a refresh', async () => {
    const loadPage = vi.fn(async () => page(REAL_EVENTS));
    const container = await render(loadPage);
    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-turn"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(rowsOf(container)).toHaveLength(1);

    const refresh = container.querySelector(
      'button[aria-label="Refresh"]',
    ) as HTMLButtonElement;
    await act(async () => refresh.click());

    // Collapse is keyed by the turn's first row, not its ordinal, so a
    // re-projection does not silently reopen what the reader closed.
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(rowsOf(container)).toHaveLength(1);
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

  it('collapses the selected turn on Enter', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    const before = rowsOf(container).length;

    await act(async () => {
      grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    await act(async () => {
      grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });

    expect(rowsOf(container).length).toBeLessThan(before);
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

  it('does not move the view when a later expand follows a failed load', async () => {
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([], { replayError: 'unreadable page' })
        : page(REAL_EVENTS, { hasMore: true, nextCursor: 'older-1' }),
    );
    const container = await render(loadPage);
    const scroll = container.querySelector('[role="grid"]') as HTMLElement;
    const turn = () =>
      container.querySelector(
        '[data-testid="trajectory-turn"]',
      ) as HTMLButtonElement;
    await act(async () => turn().click());
    expect(rowsOf(container)).toHaveLength(1);

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );
    scroll.scrollTop = 80;

    await act(async () => turn().click());

    // The failed load added no page, so the correction must not fire on the
    // next thing that lengthens the list.
    expect(rowsOf(container).length).toBeGreaterThan(1);
    expect(scroll.scrollTop).toBe(80);
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

    // A focusable turn header is what let DOM focus and the selection point at
    // different turns: Enter would collapse whichever header the pointer last
    // touched, and Space on a focused one would toggle twice — the grid's
    // keydown, then the button's own click.
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

  it('acts on the selected turn rather than on whatever was clicked', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const grid = container.querySelector('[role="grid"]') as HTMLElement;
    const headers = () =>
      Array.from(
        container.querySelectorAll('[data-testid="trajectory-turn"]'),
      ) as HTMLElement[];

    // Click one turn, then move the selection off it. The key has to follow
    // the selection, which is what the reader can see.
    await act(async () => headers()[0]!.click());
    await act(async () => headers()[0]!.click());
    await act(async () => {
      grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    const before = rowsOf(container).length;
    await act(async () => {
      grid.dispatchEvent(
        new KeyboardEvent('keydown', { key: ' ', bubbles: true }),
      );
    });

    // The selection is a record row, not the clicked header, so Space collapses
    // nothing — and above all does not re-collapse the turn behind the pointer.
    expect(rowsOf(container).length).toBe(before);
    expect(headers()[0]!.getAttribute('aria-expanded')).toBe('true');
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

  it('keeps a collapsed turn closed when its last row key is positional', async () => {
    // A timing frame with neither a record id nor a response id is keyed by
    // its index in the window, so the prepended page renames it. The anchor
    // has to skip those or the reader's collapsed turn springs back open.
    const positional = () =>
      ({
        v: 1,
        type: 'session_update',
        data: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: '' },
          _meta: {
            timing: { kind: 'request', durationMs: 10, status: 'success' },
          },
        },
      }) as unknown as DaemonEvent;
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page([userText('older', 'rec-0'), positional()])
        : page([userText('newest', 'rec-1'), positional()], {
            hasMore: true,
            nextCursor: 'older-1',
          }),
    );
    const container = await render(loadPage);
    const turns = () =>
      Array.from(
        container.querySelectorAll('[data-testid="trajectory-turn"]'),
      ) as HTMLElement[];
    await act(async () => turns()[0]!.click());
    expect(turns()[0]!.getAttribute('aria-expanded')).toBe('false');

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );

    const collapsed = turns().filter(
      (turn) => turn.getAttribute('aria-expanded') === 'false',
    );
    expect(turns().length).toBe(2);
    expect(collapsed).toHaveLength(1);
    expect(text(collapsed[0]!)).toContain('Turn 2');
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

  it('keeps a collapsed turn closed when the page it started in arrives', async () => {
    // The window opens mid-turn, so the first turn is partial: its first row
    // and its `userRowKey` both change once the prompt is finally loaded.
    const head = REAL_EVENTS.slice(4);
    const loadPage = vi.fn(async (opts: { cursor?: string; limit: number }) =>
      opts.cursor
        ? page(REAL_EVENTS.slice(0, 4))
        : page(head, { hasMore: true, nextCursor: 'older-1' }),
    );
    const container = await render(loadPage);
    const turn = () =>
      container.querySelector(
        '[data-testid="trajectory-turn"]',
      ) as HTMLButtonElement;
    await act(async () => turn().click());
    expect(turn().getAttribute('aria-expanded')).toBe('false');

    await act(async () =>
      (
        container.querySelector(
          '[data-testid="trajectory-load-older"]',
        ) as HTMLButtonElement
      ).click(),
    );

    expect(turn().getAttribute('aria-expanded')).toBe('false');
  });

  it('numbers every rendered row for assistive technology', async () => {
    const container = await render(async () => page(REAL_EVENTS));
    const grid = container.querySelector('[role="grid"]') as HTMLElement;

    expect(Number(grid.getAttribute('aria-rowcount'))).toBe(
      rowsOf(container).length,
    );
    expect(
      rowsOf(container).map((row) => row.getAttribute('aria-rowindex')),
    ).toEqual(rowsOf(container).map((_row, index) => String(index + 1)));
  });
});
