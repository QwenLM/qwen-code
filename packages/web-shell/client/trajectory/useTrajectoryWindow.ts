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
 * shorter than this.
 */
export const TRAJECTORY_PAGE_SIZE = 250;
/**
 * Pages held at once. The window is re-projected whole on every change and
 * each page is a full replay of its records, so this is what bounds the
 * retained bytes and the per-change work — and holding four pages where the
 * table held one raises both by four, to 1000 records nominally. The true
 * worst case is nearer 3000: a backward page can exceed the limit it was
 * asked for, because the daemon extends it to keep turns and tool pairs
 * whole, up to `3 * limit` records and its own 4 MB ceiling. Four is where
 * that ceiling stays defensible while still reaching a useful way back.
 */
export const TRAJECTORY_MAX_PAGES = 4;

/**
 * The fields of a transcript page this view reads. Narrower than the daemon's
 * own page type on purpose: the client's page satisfies it structurally, and a
 * test can hand back a page without standing up the rest of the envelope.
 */
export interface TrajectoryPageResult {
  events: readonly DaemonEvent[];
  nextCursor?: string;
  hasMore: boolean;
  partial?: true;
  replayError?: string;
}

/**
 * Fetches one page of the session's transcript, newest page first and older
 * pages by cursor. Supplied by the host rather than called here so the panel
 * never reaches for a daemon client of its own.
 *
 * There is no cancellation: the daemon client exposes no abort, so a superseded
 * request is discarded on arrival by generation rather than stopped in flight.
 */
export type TrajectoryPageLoader = (opts: {
  cursor?: string;
  limit: number;
}) => Promise<TrajectoryPageResult>;

/**
 * Why the last read failed. `partial` is not a message — the daemon reports it
 * as a flag — so it is carried as a kind for the view to name, rather than as
 * a word that would end up quoted at the reader.
 */
export type TrajectoryWindowFailure =
  | { kind: 'partial' }
  | { kind: 'unreadable'; message: string };

export interface TrajectoryWindow {
  trajectory: Trajectory | undefined;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: TrajectoryWindowFailure;
  /**
   * Pages currently held. The view watches this to tell an older page landing
   * apart from any other change that lengthens the list.
   */
  pageCount: number;
  /**
   * Older history exists, is reachable — the page that reported it handed back
   * a cursor — and the window has room for it.
   */
  hasOlder: boolean;
  loadingOlder: boolean;
  /** True when older history exists but the window is full. */
  atCapacity: boolean;
  loadOlder: () => void;
  refresh: () => void;
  /**
   * Re-run whichever read failed. Not the same as `refresh`: a failed older
   * page has to be re-fetched at its own cursor, because rebuilding from the
   * newest page would throw away every older page the reader already paged
   * back through.
   */
  retry: () => void;
}

interface WindowState {
  /** Fetched pages, oldest first; an older page is prepended. */
  pages: ReadonlyArray<readonly DaemonEvent[]>;
  olderCursor?: string;
  hasOlder: boolean;
  status: TrajectoryWindow['status'];
  error?: TrajectoryWindowFailure;
  /**
   * Which read produced `error`, so a retry can repeat that one. Repeating is
   * right for a transient read, which is what fails in practice; a walk whose
   * snapshot the daemon has since invalidated answers the same way every time,
   * and the header's refresh — which rebuilds from the newest page — is the
   * way out of that one.
   */
  errorFrom?: 'newest' | 'older';
  loadingOlder: boolean;
}

const EMPTY_STATE: WindowState = {
  pages: [],
  hasOlder: false,
  status: 'idle',
  loadingOlder: false,
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error ?? '');
  return text.length > 0 ? text : 'Unknown error';
}

/**
 * A page the daemon could not read in full. Its events are a prefix of the
 * truth, so folding them would show a run with records silently missing —
 * report it instead.
 */
function pageFailure(
  page: TrajectoryPageResult,
): TrajectoryWindowFailure | undefined {
  if (page.replayError) {
    return { kind: 'unreadable', message: page.replayError };
  }
  return page.partial ? { kind: 'partial' } : undefined;
}

/**
 * Hold a window of transcript pages for one session and fold it into a
 * trajectory.
 *
 * The window is this view's own: paged replay is the only path that emits
 * timing frames, and the chat store is fed by the live stream and by bulk
 * replay, neither of which carries them. Fetching here also keeps the window
 * contiguous by construction, which is what lets the projection pair a frame
 * with what it measured.
 *
 * `refresh` rebuilds the window from the newest page rather than splicing one
 * in: page boundaries are chosen per request, so a fresh newest page and the
 * held one overlap by an unknown amount and cannot be joined without dropping
 * or repeating records.
 */
export function useTrajectoryWindow(
  loadPage: TrajectoryPageLoader | undefined,
  options: { pageSize?: number; maxPages?: number } = {},
): TrajectoryWindow {
  const pageSize = options.pageSize ?? TRAJECTORY_PAGE_SIZE;
  const maxPages = options.maxPages ?? TRAJECTORY_MAX_PAGES;

  const [state, setState] = useState<WindowState>(EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Every fetch carries the generation it started in. A refresh, a loader
  // change and unmount all bump it, so a reply that arrives after any of them
  // is dropped instead of writing a window its caller no longer owns.
  const generationRef = useRef(0);
  const olderInFlightRef = useRef(false);
  const newestInFlightRef = useRef(false);

  const loadNewest = useCallback(() => {
    if (!loadPage) return;
    // Deliberately not the mirror of `loadOlder`'s guard: this one cancels a
    // page in flight rather than refusing to run. A refresh rebuilds the
    // window from the newest page, so whatever that page would have added is
    // discarded either way, and the reader sees the rebuild it asked for. The
    // reverse — a page silently discarding a refresh — leaves nothing on
    // screen to say the refresh happened, which is why that one refuses.
    const generation = ++generationRef.current;
    olderInFlightRef.current = false;
    newestInFlightRef.current = true;
    setState((previous) => ({
      ...previous,
      status: 'loading',
      error: undefined,
      loadingOlder: false,
    }));
    loadPage({ limit: pageSize }).then(
      (page) => {
        if (generationRef.current !== generation) return;
        newestInFlightRef.current = false;
        const failure = pageFailure(page);
        if (failure !== undefined) {
          // Keep whatever is already on screen: a failed refresh should not
          // also erase the run the reader was looking at.
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: failure,
            errorFrom: 'newest',
            loadingOlder: false,
          }));
          return;
        }
        setState({
          pages: [page.events],
          ...(page.nextCursor !== undefined
            ? { olderCursor: page.nextCursor }
            : {}),
          // A cursor is what `loadOlder` actually needs, so a page claiming
          // more history without one has none this view can reach. Reporting
          // it as older history would offer a button that does nothing.
          hasOlder: page.hasMore && page.nextCursor !== undefined,
          status: 'ready',
          loadingOlder: false,
        });
      },
      (error: unknown) => {
        if (generationRef.current !== generation) return;
        newestInFlightRef.current = false;
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: { kind: 'unreadable', message: errorMessage(error) },
          errorFrom: 'newest',
          loadingOlder: false,
        }));
      },
    );
  }, [loadPage, pageSize]);

  const loadOlder = useCallback(() => {
    // Refusing while the newest page is still in flight is the point, not a
    // nicety: paging bumps the generation, which would discard that reply and
    // silently drop a refresh the reader had asked for.
    if (!loadPage || olderInFlightRef.current || newestInFlightRef.current) {
      return;
    }
    const current = stateRef.current;
    const cursor = current.olderCursor;
    if (!current.hasOlder || cursor === undefined) return;
    if (current.pages.length >= maxPages) return;
    const generation = ++generationRef.current;
    olderInFlightRef.current = true;
    setState((previous) => ({ ...previous, loadingOlder: true }));
    loadPage({ cursor, limit: pageSize }).then(
      (page) => {
        if (generationRef.current !== generation) return;
        olderInFlightRef.current = false;
        const failure = pageFailure(page);
        if (failure !== undefined) {
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: failure,
            errorFrom: 'older',
            loadingOlder: false,
          }));
          return;
        }
        setState((previous) => ({
          ...previous,
          pages: [page.events, ...previous.pages],
          ...(page.nextCursor !== undefined
            ? { olderCursor: page.nextCursor }
            : { olderCursor: undefined }),
          hasOlder: page.hasMore && page.nextCursor !== undefined,
          status: 'ready',
          error: undefined,
          errorFrom: undefined,
          loadingOlder: false,
        }));
      },
      (error: unknown) => {
        if (generationRef.current !== generation) return;
        olderInFlightRef.current = false;
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: { kind: 'unreadable', message: errorMessage(error) },
          errorFrom: 'older',
          loadingOlder: false,
        }));
      },
    );
  }, [loadPage, maxPages, pageSize]);

  // The cursor and the page count both survive a failed read, so repeating it
  // is a matter of calling the same thing again.
  const retry = useCallback(() => {
    if (stateRef.current.errorFrom === 'older') {
      loadOlder();
      return;
    }
    loadNewest();
  }, [loadNewest, loadOlder]);

  useEffect(() => {
    if (!loadPage) {
      generationRef.current += 1;
      olderInFlightRef.current = false;
      newestInFlightRef.current = false;
      setState(EMPTY_STATE);
      return;
    }
    // A different loader is a different session, so the pages on screen are
    // not this loader's to keep. Only the effect resets; `refresh` reloads the
    // same session and deliberately holds the window until the reply lands.
    setState(EMPTY_STATE);
    loadNewest();
    return () => {
      generationRef.current += 1;
      olderInFlightRef.current = false;
      newestInFlightRef.current = false;
    };
  }, [loadPage, loadNewest]);

  const trajectory = useMemo(
    () =>
      state.pages.length === 0
        ? undefined
        : buildTrajectory(projectTrajectoryWindow(state.pages.flat())),
    [state.pages],
  );

  const atCapacity = state.hasOlder && state.pages.length >= maxPages;

  return {
    trajectory,
    status: state.status,
    pageCount: state.pages.length,
    ...(state.error !== undefined ? { error: state.error } : {}),
    hasOlder: state.hasOlder && !atCapacity,
    loadingOlder: state.loadingOlder,
    atCapacity,
    loadOlder,
    refresh: loadNewest,
    retry,
  };
}
