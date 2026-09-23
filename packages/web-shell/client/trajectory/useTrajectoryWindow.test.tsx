// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import {
  useTrajectoryWindow,
  type TrajectoryPageLoader,
  type TrajectoryPageResult,
  type TrajectoryWindow,
} from './useTrajectoryWindow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function requestFrame(recordId: string, durationMs: number): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '' },
      _meta: {
        timing: { kind: 'request', durationMs, status: 'ok' },
        'qwen.session.recordId': recordId,
      },
    },
  } as unknown as DaemonEvent;
}

function page(
  events: readonly DaemonEvent[],
  extra: Partial<TrajectoryPageResult> = {},
): TrajectoryPageResult {
  return { events, hasMore: false, ...extra };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(
  loadPage: TrajectoryPageLoader | undefined,
  options?: { pageSize?: number; maxPages?: number },
): {
  latest: () => TrajectoryWindow;
  rerender: (next: TrajectoryPageLoader | undefined) => void;
} {
  let latest: TrajectoryWindow | undefined;
  function Probe({ loader }: { loader: TrajectoryPageLoader | undefined }) {
    latest = useTrajectoryWindow(loader, options);
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe loader={loadPage} />);
  });
  return {
    latest: () => latest!,
    rerender: (next) => {
      act(() => {
        root!.render(<Probe loader={next} />);
      });
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  if (root) {
    const current = root;
    act(() => current.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe('useTrajectoryWindow', () => {
  it('asks for nothing without a loader', async () => {
    const view = render(undefined);
    await act(async () => {});

    expect(view.latest().status).toBe('idle');
    expect(view.latest().trajectory).toBeUndefined();
  });

  it('folds the newest page on mount', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('go', 'rec-1'), requestFrame('rec-2', 1200)]),
    );
    const view = render(loadPage);
    await act(async () => {});

    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage.mock.calls[0]![0]).toEqual({ limit: 250 });
    expect(view.latest().status).toBe('ready');
    expect(view.latest().truncated).toBe(false);
    expect(view.latest().trajectory?.rows.map((row) => row.kind)).toEqual([
      'user',
      'request',
    ]);
  });

  it('stops where the daemon hands out no cursor, and says history is left', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('newest', 'rec-1')], { hasMore: true }),
    );
    const view = render(loadPage);
    await act(async () => {});

    // There is nothing to ask the next page for, so the walk ends here and
    // the window reports the rest as a fact rather than as something to act on.
    expect(view.latest().truncated).toBe(true);
    expect(view.latest().status).toBe('ready');
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  describe('walking back', () => {
    /** Pages keyed by the cursor that asks for them; `''` is the newest. */
    function chain(
      pages: Record<string, TrajectoryPageResult | Error>,
    ): TrajectoryPageLoader & ReturnType<typeof vi.fn> {
      return vi.fn(async ({ cursor }: { limit: number; cursor?: string }) => {
        const entry = pages[cursor ?? ''];
        if (entry === undefined) throw new Error(`no page at ${cursor}`);
        if (entry instanceof Error) throw entry;
        return entry;
      });
    }

    function promptTexts(window: TrajectoryWindow): string[] {
      return window
        .trajectory!.rows.filter((row) => row.kind === 'user')
        .map((row) => (row.kind === 'user' ? row.block.text : ''));
    }

    it('follows each cursor and folds the pages oldest first', async () => {
      const loadPage = chain({
        '': page([userText('newest', 'rec-3')], {
          hasMore: true,
          nextCursor: 'c1',
        }),
        c1: page([userText('middle', 'rec-2')], {
          hasMore: true,
          nextCursor: 'c2',
        }),
        c2: page([userText('oldest', 'rec-1')]),
      });
      const statuses: string[] = [];
      let latest: TrajectoryWindow | undefined;
      function Probe() {
        latest = useTrajectoryWindow(loadPage);
        statuses.push(`${latest.status}:${latest.trajectory ? 'drawn' : '-'}`);
        return null;
      }
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => {
        root!.render(<Probe />);
      });
      await act(async () => {});

      expect(loadPage.mock.calls.map((call) => call[0])).toEqual([
        { limit: 250 },
        { limit: 250, cursor: 'c1' },
        { limit: 250, cursor: 'c2' },
      ]);
      expect(promptTexts(latest!)).toEqual(['oldest', 'middle', 'newest']);
      expect(latest!.truncated).toBe(false);
      expect(latest!.loadedPages).toBe(3);
      // Drawn once, whole: no render shows a window that later grows above
      // the rows already on screen.
      const firstDrawn = statuses.findIndex((entry) => entry.endsWith('drawn'));
      expect(statuses[firstDrawn]).toBe('ready:drawn');
      expect(statuses.slice(0, firstDrawn).every((e) => e.endsWith(':-'))).toBe(
        true,
      );
      expect(statuses.filter((e) => e.startsWith('ready')).length).toBe(
        statuses.length - firstDrawn,
      );
    });

    it('draws nothing until the walk ends, counting pages as it goes', async () => {
      const oldest = deferred<TrajectoryPageResult>();
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
        if (cursor === 'c2') return oldest.promise;
        if (cursor === 'c1') {
          return page([userText('middle', 'rec-2')], {
            hasMore: true,
            nextCursor: 'c2',
          });
        }
        return page([userText('newest', 'rec-3')], {
          hasMore: true,
          nextCursor: 'c1',
        });
      });
      const view = render(loadPage);
      await act(async () => {});

      // Two pages are in and a third is on its way: showing the two now would
      // mean putting the third above rows the reader can already see.
      expect(loadPage).toHaveBeenCalledTimes(3);
      expect(view.latest().status).toBe('loading');
      expect(view.latest().loadedPages).toBe(2);
      expect(view.latest().trajectory).toBeUndefined();

      await act(async () => {
        oldest.resolve(page([userText('oldest', 'rec-1')]));
      });
      expect(view.latest().status).toBe('ready');
      expect(view.latest().loadedPages).toBe(3);
      expect(promptTexts(view.latest())).toEqual([
        'oldest',
        'middle',
        'newest',
      ]);
    });

    it('stops at the page cap and says history is left', async () => {
      const pages: Record<string, TrajectoryPageResult> = {};
      for (let i = 0; i < 6; i += 1) {
        pages[i === 0 ? '' : `c${i}`] = page(
          [userText(`page ${i}`, `rec-${i}`)],
          { hasMore: true, nextCursor: `c${i + 1}` },
        );
      }
      const loadPage = chain(pages);
      const view = render(loadPage, { maxPages: 3 });
      await act(async () => {});

      expect(loadPage).toHaveBeenCalledTimes(3);
      expect(view.latest().loadedPages).toBe(3);
      expect(view.latest().truncated).toBe(true);
      expect(promptTexts(view.latest())).toEqual([
        'page 2',
        'page 1',
        'page 0',
      ]);
    });

    it('stops at the default cap of four pages', async () => {
      const pages: Record<string, TrajectoryPageResult> = {};
      for (let i = 0; i < 6; i += 1) {
        pages[i === 0 ? '' : `c${i}`] = page(
          [userText(`page ${i}`, `rec-${i}`)],
          { hasMore: true, nextCursor: `c${i + 1}` },
        );
      }
      const loadPage = chain(pages);
      render(loadPage);
      await act(async () => {});

      expect(loadPage).toHaveBeenCalledTimes(4);
    });

    it('keeps the newer pages when an older one cannot be read', async () => {
      const loadPage = chain({
        '': page([userText('newest', 'rec-3')], {
          hasMore: true,
          nextCursor: 'c1',
        }),
        c1: page([userText('middle', 'rec-2')], {
          hasMore: true,
          nextCursor: 'c2',
        }),
        c2: new Error('socket hang up'),
      });
      const view = render(loadPage);
      await act(async () => {});

      expect(view.latest().status).toBe('ready');
      expect(view.latest().error).toBeUndefined();
      expect(view.latest().olderFailure).toEqual({
        kind: 'unreadable',
        message: 'socket hang up',
      });
      expect(view.latest().truncated).toBe(true);
      expect(promptTexts(view.latest())).toEqual(['middle', 'newest']);
      expect(loadPage).toHaveBeenCalledTimes(3);
    });

    it('leaves a partial older page out rather than folding its hole', async () => {
      const loadPage = chain({
        '': page([userText('newest', 'rec-2')], {
          hasMore: true,
          nextCursor: 'c1',
        }),
        c1: page([userText('half of it', 'rec-1')], {
          partial: true as const,
          hasMore: true,
          nextCursor: 'c2',
        }),
      });
      const view = render(loadPage);
      await act(async () => {});

      expect(view.latest().olderFailure).toEqual({ kind: 'partial' });
      expect(promptTexts(view.latest())).toEqual(['newest']);
      expect(loadPage).toHaveBeenCalledTimes(2);
    });

    it('does not walk back from a newest page it could not read', async () => {
      const loadPage = chain({
        '': page([], {
          replayError: 'Replay conversion failed for this page',
          hasMore: true,
          nextCursor: 'c1',
        }),
        c1: page([userText('older', 'rec-1')]),
      });
      const view = render(loadPage);
      await act(async () => {});

      expect(view.latest().status).toBe('error');
      expect(loadPage).toHaveBeenCalledTimes(1);
    });

    it('rebuilds the whole window on retry after an older page failed', async () => {
      let olderFails = true;
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
        if (!cursor) {
          return page([userText('newest', 'rec-2')], {
            hasMore: true,
            nextCursor: 'c1',
          });
        }
        if (olderFails) throw new Error('down');
        return page([userText('oldest', 'rec-1')]);
      });
      const view = render(loadPage);
      await act(async () => {});
      expect(view.latest().olderFailure).toBeDefined();

      olderFails = false;
      await act(async () => {
        view.latest().refresh();
      });

      expect(view.latest().olderFailure).toBeUndefined();
      expect(view.latest().truncated).toBe(false);
      expect(promptTexts(view.latest())).toEqual(['oldest', 'newest']);
    });

    it('abandons a walk that a refresh superseded', async () => {
      const staleOlder = deferred<TrajectoryPageResult>();
      let round = 0;
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
        if (!cursor) {
          round += 1;
          return page([userText(`newest ${round}`, `rec-n${round}`)], {
            hasMore: true,
            nextCursor: `c-${round}`,
          });
        }
        if (cursor === 'c-1') return staleOlder.promise;
        return page([userText('fresh older', 'rec-o2')]);
      });
      const view = render(loadPage);
      await act(async () => {});
      expect(loadPage).toHaveBeenCalledTimes(2);

      await act(async () => {
        view.latest().refresh();
      });
      expect(loadPage).toHaveBeenCalledTimes(4);
      const settled = view.latest();

      await act(async () => {
        staleOlder.resolve(
          page([userText('stale older', 'rec-o1')], {
            hasMore: true,
            nextCursor: 'c-stale',
          }),
        );
      });

      // The old walk neither writes nor asks for the page after its reply.
      expect(loadPage).toHaveBeenCalledTimes(4);
      expect(view.latest().loadedPages).toBe(settled.loadedPages);
      expect(promptTexts(view.latest())).toEqual(['fresh older', 'newest 2']);
    });

    it('abandons a walk when the component unmounts', async () => {
      const older = deferred<TrajectoryPageResult>();
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) =>
        cursor
          ? older.promise
          : page([userText('newest', 'rec-2')], {
              hasMore: true,
              nextCursor: 'c1',
            }),
      );
      render(loadPage);
      await act(async () => {});

      const current = root!;
      act(() => current.unmount());
      root = null;

      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await act(async () => {
        older.resolve(
          page([userText('older', 'rec-1')], {
            hasMore: true,
            nextCursor: 'c2',
          }),
        );
      });
      expect(errors).not.toHaveBeenCalled();
      expect(loadPage).toHaveBeenCalledTimes(2);
    });

    it('keeps the whole window when a refresh of the newest page fails', async () => {
      let newestFails = false;
      const loadPage = vi.fn(async ({ cursor }: { cursor?: string }) => {
        if (!cursor) {
          if (newestFails) throw new Error('down');
          return page([userText('newest', 'rec-2')], {
            hasMore: true,
            nextCursor: 'c1',
          });
        }
        return page([userText('oldest', 'rec-1')]);
      });
      const view = render(loadPage);
      await act(async () => {});

      newestFails = true;
      await act(async () => {
        view.latest().refresh();
      });

      expect(view.latest().status).toBe('error');
      expect(promptTexts(view.latest())).toEqual(['oldest', 'newest']);
      expect(view.latest().loadedPages).toBe(2);
    });
  });

  it('replaces the page on refresh rather than adding to it', async () => {
    let body = 'first';
    const loadPage = vi.fn(async () => page([userText(body, 'rec-1')]));
    const view = render(loadPage);
    await act(async () => {});
    expect(view.latest().trajectory!.rows).toHaveLength(1);

    body = 'second';
    await act(async () => {
      view.latest().refresh();
    });

    // Page boundaries are picked per request, so a fresh page and the held one
    // overlap by an unknown amount and cannot be joined without dropping or
    // repeating records.
    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe('second');
  });

  it('drops a reply that a refresh has already superseded', async () => {
    const stale = deferred<TrajectoryPageResult>();
    let first = true;
    const loadPage = vi.fn(async () => {
      if (first) {
        first = false;
        return stale.promise;
      }
      return page([userText('fresh', 'rec-2')]);
    });
    const view = render(loadPage);
    await act(async () => {});

    await act(async () => {
      view.latest().refresh();
    });
    await act(async () => {
      stale.resolve(page([userText('stale', 'rec-1')]));
    });

    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe('fresh');
  });

  it('drops a failure that a refresh has already superseded', async () => {
    const stale = deferred<TrajectoryPageResult>();
    let first = true;
    const loadPage = vi.fn(async () => {
      if (first) {
        first = false;
        return stale.promise;
      }
      return page([userText('fresh', 'rec-2')]);
    });
    const view = render(loadPage);
    await act(async () => {});

    await act(async () => {
      view.latest().refresh();
    });
    await act(async () => {
      stale.reject(new Error('socket hang up'));
    });

    // The read that failed is not the one on screen, so its error is not
    // this window's to report.
    expect(view.latest().status).toBe('ready');
    expect(view.latest().error).toBeUndefined();
  });

  it('drops a reply that arrives after the loader changed', async () => {
    const stale = deferred<TrajectoryPageResult>();
    const first: TrajectoryPageLoader = vi.fn(async () => stale.promise);
    const second: TrajectoryPageLoader = vi.fn(async () =>
      page([userText('second session', 'rec-9')]),
    );
    const view = render(first);
    await act(async () => {});

    view.rerender(second);
    await act(async () => {});
    await act(async () => {
      stale.resolve(page([userText('first session', 'rec-1')]));
    });

    const rows = view.latest().trajectory!.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind === 'user' && rows[0]!.block.text).toBe(
      'second session',
    );
  });

  it("drops the previous loader's page when the loader changes", async () => {
    const first: TrajectoryPageLoader = vi.fn(async () =>
      page([userText('first session', 'rec-1')]),
    );
    const failing = deferred<TrajectoryPageResult>();
    const second: TrajectoryPageLoader = vi.fn(async () => failing.promise);
    const view = render(first);
    await act(async () => {});
    expect(view.latest().trajectory!.rows).toHaveLength(1);

    view.rerender(second);
    await act(async () => {
      failing.reject(new Error('second session is unreadable'));
    });

    // A different loader is a different session. Holding the old rows is what
    // `refresh` does, and doing it here would leave one session's trajectory
    // on screen underneath another session's error.
    expect(view.latest().trajectory).toBeUndefined();
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'second session is unreadable',
    });
  });

  it('reads again after a failure', async () => {
    let calls = 0;
    const loadPage: TrajectoryPageLoader = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return page([userText('recovered', 'rec-1')]);
    });
    const view = render(loadPage);
    await act(async () => {});
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'down',
    });

    await act(async () => view.latest().refresh());

    expect(view.latest().trajectory!.rows).toHaveLength(1);
    expect(view.latest().error).toBeUndefined();
  });

  it('keeps the held window when a page cannot be read', async () => {
    let fail = false;
    const loadPage = vi.fn(async () =>
      fail
        ? page([], { replayError: 'Replay conversion failed for this page' })
        : page([userText('kept', 'rec-1')]),
    );
    const view = render(loadPage);
    await act(async () => {});

    fail = true;
    await act(async () => {
      view.latest().refresh();
    });

    expect(view.latest().status).toBe('error');
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'Replay conversion failed for this page',
    });
    expect(view.latest().trajectory!.rows).toHaveLength(1);
  });

  it('names a partial page as a kind rather than a word', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('half', 'rec-1')], { partial: true as const }),
    );
    const view = render(loadPage);
    await act(async () => {});

    // `partial` is a flag on the page, not a sentence; carrying it as a kind
    // keeps the literal out of the message the reader is shown.
    expect(view.latest().error).toEqual({ kind: 'partial' });
  });

  it('reports a partial page as an error rather than folding a prefix', async () => {
    const loadPage = vi.fn(async () =>
      page([userText('half', 'rec-1')], { partial: true as const }),
    );
    const view = render(loadPage);
    await act(async () => {});

    expect(view.latest().status).toBe('error');
    expect(view.latest().trajectory).toBeUndefined();
  });

  it('surfaces a rejected fetch', async () => {
    const loadPage = vi.fn(async () => {
      throw new Error('daemon unreachable');
    });
    const view = render(loadPage);
    await act(async () => {});

    expect(view.latest().status).toBe('error');
    expect(view.latest().error).toEqual({
      kind: 'unreadable',
      message: 'daemon unreachable',
    });
  });

  it('does not write state after unmount', async () => {
    const pending = deferred<TrajectoryPageResult>();
    const loadPage = vi.fn(async () => pending.promise);
    render(loadPage);
    await act(async () => {});

    const current = root!;
    act(() => current.unmount());
    root = null;

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await act(async () => {
      pending.resolve(page([userText('late', 'rec-1')]));
    });
    expect(errors).not.toHaveBeenCalled();
  });
});
