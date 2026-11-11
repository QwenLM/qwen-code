import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

function getPinnedSectionOrderTime(session: DaemonSessionSummary): number {
  const pinnedAt = Date.parse(session.pinnedAt ?? '');
  return Number.isFinite(pinnedAt) ? pinnedAt : 0;
}

// Pin order is stable: sessions sort by when they were pinned (new pins
// append at the bottom), never by last activity.
export function comparePinnedSectionSessions(
  a: DaemonSessionSummary,
  b: DaemonSessionSummary,
): number {
  const byPinTime = getPinnedSectionOrderTime(a) - getPinnedSectionOrderTime(b);
  if (byPinTime !== 0) return byPinTime;
  return a.sessionId.localeCompare(b.sessionId);
}
