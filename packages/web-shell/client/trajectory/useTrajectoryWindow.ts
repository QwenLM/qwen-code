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
  | { kind: 'unreadable'; message: string };

export interface TrajectoryWindow {
  trajectory: Trajectory | undefined;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /**
   * The newest page could not be read. The window already on screen, if any,
   * is kept.
   */
  error?: TrajectoryWindowFailure;
  /**
   * Pages read so far by the load under way, or held by the window once it
   * is ready. What the placeholder counts while the walk back is running.
   */
  loadedPages: number;
  /**
   * The session has history older than the window: the walk stopped at the
   * page cap, at a page the daemon gave no cursor for, or at an older page it
   * could not read.
   */
  truncated: boolean;
  /**
   * An older page could not be read, so the window stops just after it. The
   * newer pages are drawn; `refresh` is the retry.
   */
  olderFailure?: TrajectoryWindowFailure;
  /** Read the window again from the newest page. Also every retry. */
  refresh: () => void;
}

interface WindowState {
  /** The window's pages, oldest first; undefined before the first lands. */
  pages?: ReadonlyArray<readonly DaemonEvent[]>;
  loadedPages: number;
  truncated: boolean;
  status: TrajectoryWindow['status'];
  error?: TrajectoryWindowFailure;
  olderFailure?: TrajectoryWindowFailure;
}

const EMPTY_STATE: WindowState = {
  loadedPages: 0,
  truncated: false,
  status: 'idle',
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

type PageRead =
  | { ok: true; page: TrajectoryPageResult }
  | { ok: false; failure: TrajectoryWindowFailure };

async function readPage(
  loadPage: TrajectoryPageLoader,
  opts: { limit: number; cursor?: string },
): Promise<PageRead> {
  try {
    const page = await loadPage(opts);
    const failure = pageFailure(page);
    return failure ? { ok: false, failure } : { ok: true, page };
  } catch (error) {
    return {
      ok: false,
      failure: { kind: 'unreadable', message: errorMessage(error) },
    };
  }
}

/**
 * Hold a window of one session's transcript and fold it into a trajectory.
 *
 * The pages are this view's own: paged replay is the only path that emits
 * timing frames, and the chat store is fed by the live stream and by bulk
 * replay, neither of which carries them. Reading here also keeps the window
 * contiguous by construction, which is what lets the projection pair a frame
 * with what it measured.
 *
 * A load walks back from the newest page by cursor, up to the page cap, and
 * the window lands once, whole, when the walk ends. Nothing is ever put in
 * front of rows already drawn: a list that grew upwards under the reader would
 * have to move its scroll offset, its keys, its selection and its focus in
 * step, and no part of that is observable outside a real browser.
 *
 * `refresh` rebuilds the window from the newest page rather than splicing into
 * it: page boundaries are chosen per request, so a fresh page and the held
 * ones overlap by an unknown amount and cannot be joined without dropping or
 * repeating records.
 */
export function useTrajectoryWindow(
  loadPage: TrajectoryPageLoader | undefined,
  options: { pageSize?: number; maxPages?: number } = {},
): TrajectoryWindow {
  const pageSize = options.pageSize ?? TRAJECTORY_PAGE_SIZE;
  const maxPages = options.maxPages ?? TRAJECTORY_MAX_PAGES;

  const [state, setState] = useState<WindowState>(EMPTY_STATE);
  // Every load carries the generation it started in, and checks it after each
  // read. A refresh, a loader change and unmount all bump it, so a walk they
  // superseded stops at its next reply instead of writing a window its caller
  // no longer owns — or asking for another page.
  const generationRef = useRef(0);

  const load = useCallback(() => {
    if (!loadPage) return;
    const generation = ++generationRef.current;
    const current = () => generationRef.current === generation;
    setState((previous) => ({
      ...previous,
      status: 'loading',
      error: undefined,
      loadedPages: 0,
    }));

    void (async () => {
      const newest = await readPage(loadPage, { limit: pageSize });
      if (!current()) return;
      if (!newest.ok) {
        // Keep whatever is already on screen: a failed refresh should not
        // also erase the run the reader was looking at. And do not walk on —
        // older pages hang off a cursor this read never produced.
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: newest.failure,
          loadedPages: previous.pages?.length ?? 0,
        }));
        return;
      }

      const collected: Array<readonly DaemonEvent[]> = [newest.page.events];
      let cursor = newest.page.nextCursor;
      let more = newest.page.hasMore;
      let olderFailure: TrajectoryWindowFailure | undefined;
      setState((previous) => ({ ...previous, loadedPages: 1 }));

      while (more && cursor !== undefined && collected.length < maxPages) {
        const older = await readPage(loadPage, { limit: pageSize, cursor });
        if (!current()) return;
        if (!older.ok) {
          // The page stays out: a partial one is missing records somewhere
          // inside it, which would fold into a hole nothing marks.
          olderFailure = older.failure;
          break;
        }
        collected.unshift(older.page.events);
        cursor = older.page.nextCursor;
        more = older.page.hasMore;
        const count = collected.length;
        setState((previous) => ({ ...previous, loadedPages: count }));
      }

      setState({
        pages: collected,
        loadedPages: collected.length,
        truncated: more,
        status: 'ready',
        ...(olderFailure !== undefined ? { olderFailure } : {}),
      });
    })();
  }, [loadPage, maxPages, pageSize]);

  useEffect(() => {
    if (!loadPage) {
      generationRef.current += 1;
      setState(EMPTY_STATE);
      return;
    }
    // A different loader is a different session, so the window on screen is
    // not this loader's to keep. Only the effect resets; `refresh` reloads the
    // same session and deliberately holds the window until the new one lands.
    setState(EMPTY_STATE);
    load();
    return () => {
      generationRef.current += 1;
    };
  }, [loadPage, load]);

  const pages = state.pages;
  const trajectory = useMemo(
    () =>
      pages === undefined
        ? undefined
        : buildTrajectory(projectTrajectoryWindow(pages.flat())),
    [pages],
  );

  return {
    trajectory,
    status: state.status,
    ...(state.error !== undefined ? { error: state.error } : {}),
    loadedPages: state.loadedPages,
    truncated: state.truncated,
    ...(state.olderFailure !== undefined
      ? { olderFailure: state.olderFailure }
      : {}),
    refresh: load,
  };
}
