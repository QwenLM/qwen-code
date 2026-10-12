/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DaemonEvent } from '@qwen-code/sdk/daemon';
import { buildTrajectory } from './buildTrajectory';
import { projectTrajectoryWindow } from './projectTrajectoryWindow';
import type { Trajectory } from './types';

/**
 * Records asked for per read. The daemon caps a page at 500 records and at
 * 4 MB, whichever binds first, so a session whose tools wrote a lot comes back
 * shorter than this — `truncated` is what says so, never the count.
 */
export const TRAJECTORY_PAGE_SIZE = 250;

/**
 * Pages read, newest first, before the window is drawn. The window is
 * re-projected whole on every change and each page is a full replay of its
 * records, so this is what bounds the retained bytes and the per-change work —
 * and holding four pages where the table held one raises both by four, to 1000
 * records nominally. The true worst case is nearer 3000: a backward page can
 * exceed the limit it was asked for, because the daemon extends it to keep
 * turns and tool pairs whole, up to `3 * limit` records and its own 4 MB
 * ceiling. Four is where that ceiling stays defensible while still reaching a
 * useful way back.
 */
export const TRAJECTORY_MAX_PAGES = 4;

/**
 * The fields of a transcript page this view reads. Narrower than the daemon's
 * own page type on purpose: the client's page satisfies it structurally, and a
 * test can hand back a page without standing up the rest of the envelope.
 */
export interface TrajectoryPageResult {
  events: readonly DaemonEvent[];
  hasMore: boolean;
  /** Where the next older page starts; absent when there is none to ask for. */
  nextCursor?: string;
  partial?: true;
  replayError?: string;
}

/**
 * Fetches one page of the session's transcript: the newest without a cursor,
 * the one older than a previous page with that page's `nextCursor`.
 *
 * Supplied by the host rather than called here so the panel never reaches for
 * a daemon client of its own. There is no cancellation: the daemon client
 * exposes no abort, so a superseded request is discarded on arrival by
 * generation rather than stopped in flight.
 */
export type TrajectoryPageLoader = (opts: {
  limit: number;
  cursor?: string;
}) => Promise<TrajectoryPageResult>;

/**
 * Why a read failed. `partial` is not a message — the daemon reports it as a
 * flag — so it is carried as a kind for the view to name, rather than as a
 * word that would end up quoted at the reader.
 */
export type TrajectoryWindowFailure =
  | { kind: 'partial' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'expired' | 'protocol' | 'budget' };

export const TRAJECTORY_BOOKMARK_LIMIT = 64;
export const TRAJECTORY_CURSOR_BUDGET = 256 * 1024;

export interface TrajectoryWindow {
  trajectory: Trajectory | undefined;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: TrajectoryWindowFailure;
  loadedPages: number;
  windowPages: number;
  truncated: boolean;
  olderFailure?: TrajectoryWindowFailure;
  navigationError?: TrajectoryWindowFailure;
  mode: 'latest' | 'history';
  navigationVersion: number;
  canRefresh: boolean;
  canOlder: boolean;
  canNewer: boolean;
  historyReleased: boolean;
  bookmarks: number;
  refresh: () => void;
  older: () => void;
  newer: () => void;
  retry: () => void;
}

type Pages = ReadonlyArray<readonly DaemonEvent[]>;

interface WindowState {
  pages?: Pages;
  loadedPages: number;
  truncated: boolean;
  nextCursor?: string;
  status: TrajectoryWindow['status'];
  error?: TrajectoryWindowFailure;
  olderFailure?: TrajectoryWindowFailure;
  navigationError?: TrajectoryWindowFailure;
  mode: TrajectoryWindow['mode'];
  navigationVersion: number;
  cursors: string[];
  index: number;
  historyReleased: boolean;
  blocked: boolean;
}

const EMPTY_STATE: WindowState = {
  loadedPages: 0,
  truncated: false,
  status: 'idle',
  mode: 'latest',
  navigationVersion: 0,
  cursors: [],
  index: -1,
  historyReleased: false,
  blocked: false,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '');
  return text.length > 0 ? text : 'Unknown error';
}

function readFailure(error: unknown): TrajectoryWindowFailure {
  // REST errors expose body.code; ACP transports use body.data.errorKind.
  const body =
    typeof error === 'object' && error !== null && 'body' in error
      ? error.body
      : undefined;
  if (typeof body === 'object' && body !== null) {
    const code = 'code' in body ? body.code : undefined;
    const data = 'data' in body ? body.data : undefined;
    const kind =
      typeof data === 'object' && data !== null && 'errorKind' in data
        ? data.errorKind
        : undefined;
    if (
      [code, kind].some(
        (value) =>
          value === 'invalid_transcript_cursor' ||
          value === 'transcript_snapshot_unavailable',
      )
    )
      return { kind: 'expired' };
  }
  return { kind: 'unreadable', message: errorMessage(error) };
}

interface Operation {
  kind: 'latest' | 'older' | 'newer';
  start?: string;
  cursor?: string;
  pages: Array<readonly DaemonEvent[]>;
  seen: Set<string>;
  target: number;
}

/**
 * Windows are contiguous cursor walks, committed whole. Only bookmarks survive
 * a switch: replaying a saved cursor stays in its snapshot, whereas a read
 * without one explicitly returns to the latest snapshot.
 */
export function useTrajectoryWindow(
  loadPage: TrajectoryPageLoader | undefined,
  options: {
    pageSize?: number;
    maxPages?: number;
    bookmarkLimit?: number;
    cursorBudget?: number;
  } = {},
): TrajectoryWindow {
  const pageSize = options.pageSize ?? TRAJECTORY_PAGE_SIZE;
  const maxPages = options.maxPages ?? TRAJECTORY_MAX_PAGES;
  const bookmarkLimit = options.bookmarkLimit ?? TRAJECTORY_BOOKMARK_LIMIT;
  const cursorBudget = options.cursorBudget ?? TRAJECTORY_CURSOR_BUDGET;
  const [state, setState] = useState<WindowState>(EMPTY_STATE);
  const stateRef = useRef(state);
  const generationRef = useRef(0);
  const pendingRef = useRef<Operation | undefined>(undefined);

  const update = useCallback((next: WindowState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const run = useCallback(
    (operation: Operation) => {
      if (!loadPage) return;
      const generation = ++generationRef.current;
      const previous = pendingRef.current;
      if (previous && previous !== operation) {
        previous.pages = [];
        previous.seen.clear();
      }
      pendingRef.current = operation;
      const current = () => generationRef.current === generation;
      update({
        ...stateRef.current,
        status: 'loading',
        error: undefined,
        navigationError:
          operation.kind === 'latest'
            ? undefined
            : stateRef.current.navigationError,
        loadedPages: operation.pages.length,
      });

      const fail = (failure: TrajectoryWindowFailure) => {
        const previous = stateRef.current;
        const blocked =
          failure.kind === 'expired' ||
          failure.kind === 'protocol' ||
          failure.kind === 'budget';
        // On the first load, the readable prefix is useful. Subsequent failed
        // replacements retain the entire window the reader was already using.
        if (!previous.pages && operation.pages.length > 0) {
          update({
            ...previous,
            pages: [...operation.pages],
            status: 'ready',
            loadedPages: operation.pages.length,
            truncated: true,
            nextCursor: operation.cursor,
            olderFailure: failure,
            blocked,
          });
        } else {
          const fillingInitialWindow = previous.olderFailure !== undefined;
          update({
            ...previous,
            status:
              previous.pages &&
              (operation.kind !== 'latest' || fillingInitialWindow)
                ? 'ready'
                : 'error',
            loadedPages: previous.pages?.length ?? 0,
            ...(fillingInitialWindow
              ? { olderFailure: failure }
              : operation.kind === 'latest'
                ? { error: failure }
                : { navigationError: failure }),
            blocked: previous.blocked || blocked,
          });
        }
        if (blocked) pendingRef.current = undefined;
      };

      void (async () => {
        let more = true;
        while (operation.pages.length < maxPages && more) {
          const cursor = operation.cursor;
          if (cursor !== undefined && cursor.length > cursorBudget) {
            fail({ kind: 'budget' });
            return;
          }
          let page: TrajectoryPageResult;
          try {
            page = await loadPage({
              limit: pageSize,
              ...(cursor !== undefined ? { cursor } : {}),
            });
          } catch (error) {
            if (current()) fail(readFailure(error));
            return;
          }
          if (!current()) return;
          if (page.partial || page.replayError) {
            fail(
              page.replayError
                ? { kind: 'unreadable', message: page.replayError }
                : { kind: 'partial' },
            );
            return;
          }
          if (cursor !== undefined) operation.seen.add(cursor);
          operation.pages.unshift(page.events);
          more = page.hasMore;
          operation.cursor = page.nextCursor;
          if (
            more &&
            (!page.nextCursor ||
              operation.seen.has(page.nextCursor) ||
              (operation.kind !== 'latest' &&
                stateRef.current.cursors
                  .slice(0, operation.target + 1)
                  .includes(page.nextCursor)))
          ) {
            fail({ kind: 'protocol' });
            return;
          }
          update({
            ...stateRef.current,
            loadedPages: operation.pages.length,
          });
        }
        const previous = stateRef.current;
        let cursors = previous.cursors;
        let index = operation.target;
        let historyReleased = previous.historyReleased;
        if (operation.kind === 'latest') {
          cursors = [];
          index = -1;
          historyReleased = false;
        } else if (index === cursors.length) {
          cursors = [...cursors, operation.start!];
          let bytes = cursors.reduce(
            (total, cursor) => total + cursor.length,
            0,
          );
          while (cursors.length > bookmarkLimit || bytes > cursorBudget) {
            bytes -= cursors[0]!.length;
            cursors = cursors.slice(1);
            index -= 1;
            historyReleased = true;
          }
        }
        pendingRef.current = undefined;
        update({
          pages: operation.pages,
          loadedPages: operation.pages.length,
          status: 'ready',
          truncated: more,
          nextCursor: more ? operation.cursor : undefined,
          mode: operation.kind === 'latest' ? 'latest' : 'history',
          navigationVersion:
            previous.navigationVersion +
            (operation.kind !== 'latest' || previous.mode === 'history'
              ? 1
              : 0),
          cursors,
          index,
          historyReleased,
          blocked: false,
        });
      })();
    },
    [loadPage, pageSize, maxPages, bookmarkLimit, cursorBudget, update],
  );

  const refresh = useCallback(() => {
    run({ kind: 'latest', pages: [], seen: new Set(), target: -1 });
  }, [run]);

  const older = useCallback(() => {
    const previous = stateRef.current;
    if (
      previous.status === 'loading' ||
      previous.blocked ||
      previous.olderFailure ||
      pendingRef.current ||
      !previous.nextCursor
    )
      return;
    const target = previous.index + 1;
    const start = previous.cursors[target] ?? previous.nextCursor;
    if (previous.cursors.slice(0, target).includes(start)) {
      update({
        ...previous,
        navigationError: { kind: 'protocol' },
        blocked: true,
      });
      return;
    }
    run({
      kind: 'older',
      start,
      cursor: start,
      pages: [],
      seen: new Set(),
      target,
    });
  }, [run, update]);

  const newer = useCallback(() => {
    const previous = stateRef.current;
    if (
      previous.status === 'loading' ||
      previous.blocked ||
      previous.olderFailure ||
      pendingRef.current ||
      previous.index <= 0
    )
      return;
    const target = previous.index - 1;
    const start = previous.cursors[target]!;
    run({
      kind: 'newer',
      start,
      cursor: start,
      pages: [],
      seen: new Set(),
      target,
    });
  }, [run]);

  const retry = useCallback(() => {
    if (stateRef.current.status === 'loading') return;
    const operation = pendingRef.current;
    if (operation) run(operation);
  }, [run]);

  useEffect(() => {
    update(EMPTY_STATE);
    pendingRef.current = undefined;
    if (loadPage) refresh();
    return () => {
      generationRef.current += 1;
      if (pendingRef.current) {
        pendingRef.current.pages = [];
        pendingRef.current.seen.clear();
      }
      pendingRef.current = undefined;
    };
  }, [loadPage, refresh, update]);

  const pages = state.pages;
  const trajectory = useMemo(
    () =>
      pages === undefined
        ? undefined
        : buildTrajectory(projectTrajectoryWindow(pages.flat())),
    [pages],
  );
  const navigable =
    state.status !== 'loading' &&
    !state.blocked &&
    !state.olderFailure &&
    !state.navigationError &&
    !pendingRef.current;

  return {
    trajectory,
    status: state.status,
    error: state.error,
    loadedPages: state.loadedPages,
    windowPages: state.pages?.length ?? 0,
    truncated: state.truncated,
    olderFailure: state.olderFailure,
    navigationError: state.navigationError,
    mode: state.mode,
    navigationVersion: state.navigationVersion,
    canRefresh: Boolean(
      loadPage &&
        (state.status !== 'loading' || pendingRef.current?.kind !== 'latest'),
    ),
    canOlder: Boolean(navigable && state.nextCursor),
    canNewer: Boolean(navigable && state.index > 0),
    historyReleased: state.historyReleased,
    bookmarks: state.cursors.length,
    refresh,
    older,
    newer,
    retry,
  };
}
