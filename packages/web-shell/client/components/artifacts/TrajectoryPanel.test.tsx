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

  it('says so when the window holds no recorded timing', async () => {
    const container = await render(async () => page([userText('go', 'rec-1')]));

    // Inside the overview's fixed box: a notice of its own above the table
    // would be one more thing that moves the rows when it comes and goes.
    expect(
      text(container.querySelector('[data-testid="trajectory-overview"]')),
    ).toContain('No request or tool durations are recorded');
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

  describe('overview', () => {
    const START = 1_760_000_000_000;
    /** Two timed turns: a request with its first token, then a tool. */
    const timedTurns = () => [
      userText('first', 'rec-1'),
      timingFrame(
        {
          kind: 'request',
          durationMs: 1000,
          ttftMs: 400,
          startedAt: START,
          status: 'ok',
          model: 'qwen3.8-max',
        },
        'rec-2',
      ),
      toolCall('call-1', 'read_file', 'ReadFile: note.txt', 'rec-3'),
      timingFrame(
        {
          kind: 'tool',
          durationMs: 250,
          startedAt: START + 1000,
          callId: 'call-1',
          toolName: 'read_file',
          toolStatus: 'success',
        },
        'rec-4',
      ),
      userText('second', 'rec-5'),
      timingFrame(
        {
          kind: 'request',
          durationMs: 500,
          startedAt: START + 60_000,
          status: 'error',
          model: 'qwen3.8-max',
        },
        'rec-6',
      ),
    ];
    const spansIn = (container: HTMLElement) =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-testid="trajectory-span"]',
        ),
      );
    const activeRow = (container: HTMLElement) => {
      const grid = container.querySelector('[role="grid"]') as HTMLElement;
      const id = grid.getAttribute('aria-activedescendant');
      return id ? document.getElementById(id) : null;
    };

    it('sits above the table, outside the scrolled rows', async () => {
      const container = await render(async () => page(timedTurns()));
      const overview = container.querySelector(
        '[data-testid="trajectory-overview"]',
      )!;
      const scroll = container.querySelector('[role="grid"]') as HTMLElement;

      expect(scroll.contains(overview)).toBe(false);
      expect(
        overview.compareDocumentPosition(scroll) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(scroll.children).toHaveLength(1);
    });

    it('draws the timed records of a real page', async () => {
      const container = await render(async () => page(REAL_EVENTS));
      expect(spansIn(container).length).toBeGreaterThan(0);
    });

    /** Track geometry for the pointer maths; jsdom lays nothing out. */
    const PLOT_LEFT = 50;
    const PLOT_WIDTH = 400;
    const at = (fraction: number) => PLOT_LEFT + fraction * PLOT_WIDTH;
    const plotOf = (container: HTMLElement) => {
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
    };
    /** jsdom has no PointerEvent; React only reads the native type. */
    const pointer = async (
      target: Element,
      type: 'pointerdown' | 'pointermove' | 'pointerup',
      clientX: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX,
        button: 0,
      });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      await act(async () => {
        target.dispatchEvent(event);
      });
    };
    const pressSpan = async (container: HTMLElement, span: HTMLElement) => {
      const plot = plotOf(container);
      await pointer(span, 'pointerdown', at(0.5));
      await pointer(plot, 'pointerup', at(0.5));
    };
    const drag = async (container: HTMLElement, from: number, to: number) => {
      const plot = plotOf(container);
      await pointer(plot, 'pointerdown', at(from));
      await pointer(plot, 'pointermove', at(to));
      await pointer(plot, 'pointerup', at(to));
    };
    const rowCount = (container: HTMLElement) =>
      Number(
        container
          .querySelector('[role="grid"]')
          ?.getAttribute('aria-rowcount') ?? 0,
      );
    const keydown = async (container: HTMLElement, key: string) => {
      const grid = container.querySelector('[role="grid"]') as HTMLElement;
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        grid.dispatchEvent(event);
      });
      return event;
    };

    it('selects the row a clicked span stands for', async () => {
      const container = await render(async () => page(timedTurns()));
      const tool = spansIn(container).find((el) => el.dataset['lane'] === '1')!;

      await pressSpan(container, tool);

      expect(text(activeRow(container))).toContain('ReadFile: note.txt');
    });

    describe('time selection', () => {
      // The domain is 1750 ms: the first turn's request (0–1000) and tool
      // (1000–1250), then the second turn's request (1250–1750) once the
      // minute of idle between them is cut. Seven rows unfiltered: two turn
      // headers, two prompts, two requests and the tool.
      const UNFILTERED_ROWS = 7;

      it('keeps only the turns that ran in the dragged time', async () => {
        const container = await render(async () => page(timedTurns()));
        expect(rowCount(container)).toBe(UNFILTERED_ROWS);

        // 1312–1662 ms: inside the second request only.
        await drag(container, 0.75, 0.95);

        expect(rowCount(container)).toBe(3);
        const grid = container.querySelector('[role="grid"]')!;
        expect(text(grid)).toContain('second');
        expect(text(grid)).not.toContain('first');
        expect(
          text(
            container.querySelector('[data-testid="trajectory-range-status"]'),
          ),
        ).toBe('Showing 2 of 5 rows in the selected time');
        expect(
          container.querySelector('[data-testid="trajectory-totals"]'),
        ).toBeNull();
      });

      it('keeps a turn prompt but drops what ran outside the time', async () => {
        const container = await render(async () => page(timedTurns()));

        // 100–400 ms: the first request, not the tool after it.
        await drag(container, 100 / 1750, 400 / 1750);

        const grid = container.querySelector('[role="grid"]')!;
        expect(rowCount(container)).toBe(3);
        expect(text(grid)).toContain('first');
        expect(text(grid)).not.toContain('ReadFile');
      });

      it('restores every row from the clear button', async () => {
        const container = await render(async () => page(timedTurns()));
        await drag(container, 0.75, 0.95);

        const clear = container.querySelector<HTMLButtonElement>(
          '[data-testid="trajectory-range-clear"]',
        )!;
        expect(clear.getAttribute('aria-label')).toBe('Clear time selection');
        await act(async () => clear.click());

        expect(rowCount(container)).toBe(UNFILTERED_ROWS);
        expect(
          container.querySelector('[data-testid="trajectory-range-clear"]'),
        ).toBeNull();
        expect(
          container.querySelector('[data-testid="trajectory-totals"]'),
        ).not.toBeNull();
      });

      it('restores every row on Escape, and leaves Escape alone otherwise', async () => {
        const container = await render(async () => page(timedTurns()));

        expect((await keydown(container, 'Escape')).defaultPrevented).toBe(
          false,
        );

        await drag(container, 0.75, 0.95);
        expect(rowCount(container)).toBe(3);
        expect((await keydown(container, 'Escape')).defaultPrevented).toBe(
          true,
        );
        expect(rowCount(container)).toBe(UNFILTERED_ROWS);
      });

      it('drops the selection when the window is read again', async () => {
        // A fresh page each read, as the daemon hands back.
        const container = await render(async () => page(timedTurns()));
        await drag(container, 0.75, 0.95);
        expect(rowCount(container)).toBe(3);

        const refresh = container.querySelector<HTMLButtonElement>(
          'button[aria-label="Refresh"]',
        )!;
        await act(async () => refresh.click());

        expect(rowCount(container)).toBe(UNFILTERED_ROWS);
        expect(
          container.querySelector('[data-testid="trajectory-range"]'),
        ).toBeNull();
      });

      it('shows a span pressed outside the time by dropping the selection', async () => {
        const container = await render(async () => page(timedTurns()));
        await drag(container, 0.75, 0.95);
        const tool = spansIn(container).find(
          (el) => el.dataset['lane'] === '1',
        )!;
        expect(tool.dataset['dimmed']).toBe('true');

        await pressSpan(container, tool);

        expect(rowCount(container)).toBe(UNFILTERED_ROWS);
        expect(text(activeRow(container))).toContain('ReadFile: note.txt');
      });
    });

    it('lights the span of the row the keyboard selected', async () => {
      const container = await render(async () => page(timedTurns()));
      const grid = container.querySelector('[role="grid"]') as HTMLElement;
      const press = async (key: string) => {
        await act(async () => {
          grid.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        });
      };

      // Turn header, prompt, then the first request.
      await press('ArrowDown');
      await press('ArrowDown');
      await press('ArrowDown');

      const current = spansIn(container).filter(
        (el) => el.dataset['current'] === 'true',
      );
      expect(current).toHaveLength(1);
      expect(current[0]!.dataset['lane']).toBe('0');
      expect(current[0]!.dataset['ttft']).toBe('true');
    });

    it('names a span the way its row reads, with the failure in words', async () => {
      const container = await render(async () => page(timedTurns()));
      const [first, , failed] = spansIn(container);

      expect(first!.title).toBe('qwen3.8-max · 1.0s · TTFT 400ms');
      expect(failed!.dataset['error']).toBe('true');
      expect(failed!.title).toBe('qwen3.8-max · Request failed · 500ms');
    });
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
    // The bar is still there, empty: it holds its height so a refresh that
    // changes what it says cannot move the grid under it.
    const bar = container.querySelector('[data-testid="trajectory-older-bar"]');
    expect(bar).not.toBeNull();
    expect(text(bar)).toBe('');
  });

  describe('walking back through pages', () => {
    const prompts = (label: string, count: number) =>
      Array.from({ length: count }, (_unused, index) =>
        userText(`${label} prompt ${index + 1}`, `rec-${label}-${index + 1}`),
      );

    it('folds every page it walked back through into one table', async () => {
      const loadPage: TrajectoryPageLoader = vi.fn(async ({ cursor }) =>
        cursor === 'c1'
          ? page(prompts('older', 2))
          : page(prompts('newer', 3), { hasMore: true, nextCursor: 'c1' }),
      );
      const container = await render(loadPage);
      await act(async () => {});

      const grid = container.querySelector('[role="grid"]') as HTMLElement;
      // Five prompts, each a turn header and a user row.
      expect(grid.getAttribute('aria-rowcount')).toBe('10');
      expect(
        text(container.querySelector('[data-testid="trajectory-totals"]')),
      ).toContain('5 turns');
      expect(
        container.querySelector('[data-testid="trajectory-truncated"]'),
      ).toBeNull();
    });

    it('counts the pages read while it walks back', async () => {
      let releaseOlder!: (value: TrajectoryPageResult) => void;
      const older = new Promise<TrajectoryPageResult>((resolve) => {
        releaseOlder = resolve;
      });
      const container = await render(async ({ cursor }) =>
        cursor
          ? older
          : page(prompts('newer', 1), { hasMore: true, nextCursor: 'c1' }),
      );
      await act(async () => {});

      expect(container.querySelector('[role="grid"]')).toBeNull();
      expect(text(container.querySelector('[role="status"]'))).toContain(
        '1 page so far',
      );

      await act(async () => {
        releaseOlder(page(prompts('older', 1)));
      });
      expect(
        (container.querySelector('[role="grid"]') as HTMLElement).getAttribute(
          'aria-rowcount',
        ),
      ).toBe('4');
    });

    it('draws the newer pages and offers a retry when an older one fails', async () => {
      let olderFails = true;
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
        if (!cursor) {
          return page(prompts('newer', 2), { hasMore: true, nextCursor: 'c1' });
        }
        if (olderFails) throw new Error('socket hang up');
        return page(prompts('older', 1));
      });
      const container = await render(loadPage);
      await act(async () => {});

      const grid = () =>
        container.querySelector('[role="grid"]') as HTMLElement;
      expect(grid().getAttribute('aria-rowcount')).toBe('4');
      const failed = container.querySelector(
        '[data-testid="trajectory-older-failed"]',
      );
      expect(text(failed)).toBe(
        'Earlier records could not be read: socket hang up',
      );
      // The newest page read fine, so nothing is raised as an alert.
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(grid().children).toHaveLength(1);
      expect(grid().contains(failed)).toBe(false);

      olderFails = false;
      const retry = container.querySelector(
        '[data-testid="trajectory-older-retry"]',
      ) as HTMLButtonElement;
      expect(retry.disabled).toBe(false);
      await act(async () => {
        retry.click();
      });
      await act(async () => {});

      expect(grid().getAttribute('aria-rowcount')).toBe('6');
      expect(
        container.querySelector('[data-testid="trajectory-older-failed"]'),
      ).toBeNull();
    });

    it('names an older page read only in part without quoting the flag', async () => {
      const container = await render(async ({ cursor }) =>
        cursor
          ? page(prompts('older', 1), { partial: true as const })
          : page(prompts('newer', 1), { hasMore: true, nextCursor: 'c1' }),
      );
      await act(async () => {});

      expect(
        text(
          container.querySelector('[data-testid="trajectory-older-failed"]'),
        ),
      ).toBe(
        'Earlier records could only be read in part, so they are left out.',
      );
    });

    it('does not start a second walk while one is under way', async () => {
      let releaseNewest: ((value: TrajectoryPageResult) => void) | undefined;
      let reads = 0;
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
        reads += 1;
        if (cursor) throw new Error('down');
        if (reads === 1) {
          return page(prompts('newer', 1), { hasMore: true, nextCursor: 'c1' });
        }
        return new Promise<TrajectoryPageResult>((resolve) => {
          releaseNewest = resolve;
        });
      });
      const container = await render(loadPage);
      await act(async () => {});
      const retry = () =>
        container.querySelector(
          '[data-testid="trajectory-older-retry"]',
        ) as HTMLButtonElement;

      await act(async () => {
        retry().click();
      });
      const during = loadPage.mock.calls.length;
      expect(retry().getAttribute('aria-disabled')).toBe('true');
      await act(async () => {
        retry().click();
      });
      expect(loadPage.mock.calls.length).toBe(during);

      await act(async () => {
        releaseNewest?.(page(prompts('newer', 1)));
      });
    });
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
