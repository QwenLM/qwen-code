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

  it('says the page left history out, outside the scrolled rows', async () => {
    const container = await render(async () =>
      page(REAL_EVENTS, { hasMore: true }),
    );
    const scroll = container.querySelector('[role="grid"]') as HTMLElement;
    const notice = container.querySelector(
      '[data-testid="trajectory-truncated"]',
    );

    expect(text(notice)).toContain('most recent records');
    // Inside the scrolled box its height would offset every virtual row from
    // the coordinates the virtualizer hands out.
    expect(scroll.contains(notice)).toBe(false);
    expect(scroll.children).toHaveLength(1);
  });

  it('says nothing about older history when the page is the whole session', async () => {
    const container = await render(async () => page(REAL_EVENTS));

    expect(
      container.querySelector('[data-testid="trajectory-truncated"]'),
    ).toBeNull();
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
