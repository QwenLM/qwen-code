/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TrajectoryLifecycleProjection } from './project-trajectory-lifecycle';
import type { TrajectoryWindowFailure } from './useTrajectoryWindow';

/** What the summary bar's single status control says. */
export type TrajectoryPillState =
  | 'none'
  | 'live'
  | 'connecting'
  | 'reconnecting'
  | 'paused'
  | 'returning'
  | 'history';

export function trajectoryPillState(input: {
  windowMode: 'latest' | 'history';
  following: boolean;
  returning: boolean;
  liveStatus: TrajectoryLifecycleProjection['status'];
}): TrajectoryPillState {
  if (input.returning) return 'returning';
  if (input.windowMode === 'history') return 'history';
  if (!input.following) return 'paused';
  switch (input.liveStatus) {
    case 'live':
      return 'live';
    case 'catching-up':
      return 'connecting';
    case 'stale':
      return 'reconnecting';
    default:
      return 'none';
  }
}

export type TrajectoryWarning =
  | { kind: 'refresh-failed'; failure: TrajectoryWindowFailure }
  | { kind: 'navigation-failed'; failure: TrajectoryWindowFailure }
  | { kind: 'history-gap' }
  | { kind: 'lifecycle-incomplete' };

/**
 * Conditions worth acting on or knowing about while records are on screen,
 * most urgent first. A read that failed with nothing loaded is not a warning:
 * the list itself says so.
 */
export function trajectoryWarnings(input: {
  hasTrajectory: boolean;
  error?: TrajectoryWindowFailure;
  navigationError?: TrajectoryWindowFailure;
  historyStale: boolean;
  lifecycleIncomplete: boolean;
}): TrajectoryWarning[] {
  const warnings: TrajectoryWarning[] = [];
  if (input.error && input.hasTrajectory)
    warnings.push({ kind: 'refresh-failed', failure: input.error });
  if (input.navigationError)
    warnings.push({
      kind: 'navigation-failed',
      failure: input.navigationError,
    });
  if (input.historyStale) warnings.push({ kind: 'history-gap' });
  if (input.lifecycleIncomplete)
    warnings.push({ kind: 'lifecycle-incomplete' });
  return warnings;
}

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** What a failed read says, wherever it is shown. */
export function trajectoryFailureText(
  failure: TrajectoryWindowFailure,
  t: Translate,
): string {
  if (failure.kind === 'partial') return t('trajectory.partial');
  if (failure.kind === 'unreadable')
    return t('trajectory.loadFailed', { message: failure.message });
  return t(`trajectory.window.${failure.kind}`);
}

/** Only an unreadable or partial page can be read again with the same cursor. */
export function isRetryableFailure(failure: TrajectoryWindowFailure): boolean {
  return failure.kind === 'partial' || failure.kind === 'unreadable';
}

/** The row above the first record: what lies before the loaded window. */
export type TrajectoryTopBoundary = 'start' | 'earlier' | 'loading' | 'failed';

export function trajectoryTopBoundary(input: {
  truncated: boolean;
  loading: boolean;
  olderFailure?: TrajectoryWindowFailure;
}): TrajectoryTopBoundary {
  if (input.olderFailure) return 'failed';
  if (input.loading) return 'loading';
  return input.truncated ? 'earlier' : 'start';
}
