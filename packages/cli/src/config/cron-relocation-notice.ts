/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rewords the cron scheduler's exit summary for a `/cd`: the scheduler is
 * destroyed and restarted for the new project, and its session-only jobs
 * and loop wakeups do not survive the swap. The summary is phrased for
 * session exit ("Session ending. N active loops cancelled: …"); the move
 * is not the end of the session, only of those loops.
 */
export function formatCronRelocationNotice(exitSummary: string): string {
  const cancelled = exitSummary.replace(/^Session ending\.\s*/, '');
  return `Working directory changed; ${cancelled}`;
}
