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
 * The fields of a transcript page this view reads. Narrower than the daemon's
 * own page type on purpose: the client's page satisfies it structurally, and a
 * test can hand back a page without standing up the rest of the envelope.
 */
export interface TrajectoryPageResult {
  events: readonly DaemonEvent[];
  hasMore: boolean;
  partial?: true;
  replayError?: string;
}

/**
 * Fetches the newest page of the session's transcript.
 *
 * Supplied by the host rather than called here so the panel never reaches for
 * a daemon client of its own. There is no cancellation: the daemon client
 * exposes no abort, so a superseded request is discarded on arrival by
 * generation rather than stopped in flight.
 */
export type TrajectoryPageLoader = (opts: {
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
   * The session has history older than what this page carries. Nothing here
   * can reach it yet, so the view says so rather than offering an action.
   */
  truncated: boolean;
  /** Re-read the newest page. Also how a failed read is retried. */
  refresh: () => void;
}

interface WindowState {
  /** The newest page's events, or undefined before the first one lands. */
  events?: readonly DaemonEvent[];
  truncated: boolean;
  status: TrajectoryWindow['status'];
  error?: TrajectoryWindowFailure;
}

const EMPTY_STATE: WindowState = {
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

/**
 * Hold the newest page of one session's transcript and fold it into a
 * trajectory.
 *
 * The page is this view's own: paged replay is the only path that emits timing
 * frames, and the chat store is fed by the live stream and by bulk replay,
 * neither of which carries them. Reading here also keeps the window contiguous
 * by construction, which is what lets the projection pair a frame with what it
 * measured.
 *
 * `refresh` replaces the page rather than splicing into it: page boundaries
 * are chosen per request, so a fresh page and the held one overlap by an
 * unknown amount and cannot be joined without dropping or repeating records.
 */
export function useTrajectoryWindow(
  loadPage: TrajectoryPageLoader | undefined,
  options: { pageSize?: number } = {},
): TrajectoryWindow {
  const pageSize = options.pageSize ?? TRAJECTORY_PAGE_SIZE;

  const [state, setState] = useState<WindowState>(EMPTY_STATE);
  // Every fetch carries the generation it started in. A refresh, a loader
  // change and unmount all bump it, so a reply that arrives after any of them
  // is dropped instead of writing a window its caller no longer owns.
  const generationRef = useRef(0);

  const loadNewest = useCallback(() => {
    if (!loadPage) return;
    const generation = ++generationRef.current;
    setState((previous) => ({
      ...previous,
      status: 'loading',
      error: undefined,
    }));
    loadPage({ limit: pageSize }).then(
      (page) => {
        if (generationRef.current !== generation) return;
        const failure = pageFailure(page);
        if (failure !== undefined) {
          // Keep whatever is already on screen: a failed refresh should not
          // also erase the run the reader was looking at.
          setState((previous) => ({
            ...previous,
            status: 'error',
            error: failure,
          }));
          return;
        }
        setState({
          events: page.events,
          truncated: page.hasMore,
          status: 'ready',
        });
      },
      (error: unknown) => {
        if (generationRef.current !== generation) return;
        setState((previous) => ({
          ...previous,
          status: 'error',
          error: { kind: 'unreadable', message: errorMessage(error) },
        }));
      },
    );
  }, [loadPage, pageSize]);

  useEffect(() => {
    if (!loadPage) {
      generationRef.current += 1;
      setState(EMPTY_STATE);
      return;
    }
    // A different loader is a different session, so the page on screen is not
    // this loader's to keep. Only the effect resets; `refresh` reloads the same
    // session and deliberately holds the window until the reply lands.
    setState(EMPTY_STATE);
    loadNewest();
    return () => {
      generationRef.current += 1;
    };
  }, [loadPage, loadNewest]);

  const events = state.events;
  const trajectory = useMemo(
    () =>
      events === undefined
        ? undefined
        : buildTrajectory(projectTrajectoryWindow(events)),
    [events],
  );

  return {
    trajectory,
    status: state.status,
    ...(state.error !== undefined ? { error: state.error } : {}),
    truncated: state.truncated,
    refresh: loadNewest,
  };
}
