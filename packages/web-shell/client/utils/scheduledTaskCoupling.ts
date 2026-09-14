/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The daemon couples a scheduled task to its bound session by sessionId
 * alone (disable/enable/removeTasksForSessions), so archiving, deleting, or
 * restoring ANY bound session silently drives the task — including an
 * ordinary chat bound through the cron tool's `sessionMode: 'current'`
 * path, whose eligibility check requires an ordinary session. The persisted
 * catalog flags such sessions with `boundScheduledTaskId`. The `sourceType`
 * half keeps a dedicated controller covered when the flag is absent (a
 * pre-flag daemon serving a newer client).
 */
export function isScheduledTaskCoupledSession(session: {
  sourceType?: string;
  boundScheduledTaskId?: string;
}): boolean {
  return (
    session.sourceType === 'scheduled_task' ||
    session.boundScheduledTaskId !== undefined
  );
}
