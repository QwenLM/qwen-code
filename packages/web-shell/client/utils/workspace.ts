/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonCapabilities,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';

/**
 * Last path segment of an absolute workspace cwd, for a compact per-workspace
 * label (e.g. `/home/me/projects/api` → `api`). Falls back to the full path when
 * it has no segments. Mirrors the sidebar's `WorkspaceSection` naming so the
 * split view / overview label a workspace the same way its sidebar section does.
 */
export function workspaceBasename(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

/**
 * True when the daemon advertises more than one registered workspace — i.e. the
 * multi-workspace session surfaces (per-workspace labels/tags) should show.
 * A single-workspace daemon omits `workspaces` (or lists just the primary), so
 * every workspace-scoped affordance stays hidden and the UI is unchanged.
 */
export function hasMultipleWorkspaces(
  capabilities: DaemonCapabilities | undefined,
): boolean {
  return (capabilities?.workspaces?.length ?? 0) > 1;
}

/**
 * Whether a session belongs to a workspace other than the primary one. Both cwds
 * are daemon-canonicalized, so a raw string compare is correct. Returns false
 * when either cwd is unknown (treat as primary) so single-workspace never tags.
 */
export function isNonPrimaryWorkspaceSession(
  workspaceCwd: string | undefined,
  primaryCwd: string | undefined,
): boolean {
  return !!workspaceCwd && !!primaryCwd && workspaceCwd !== primaryCwd;
}

/**
 * Merge the primary workspace's sessions with the sessions collected from other
 * workspaces into one list, keyed by `sessionId` (primary wins on the unlikely
 * id collision). Returns the primary list unchanged (same reference) when there
 * are no other-workspace sessions, so the single-workspace path is a no-op.
 */
export function mergeSessionsById(
  primary: DaemonSessionSummary[],
  others: DaemonSessionSummary[],
): DaemonSessionSummary[] {
  if (others.length === 0) return primary;
  const byId = new Map<string, DaemonSessionSummary>();
  for (const session of primary) byId.set(session.sessionId, session);
  for (const session of others) {
    if (!byId.has(session.sessionId)) byId.set(session.sessionId, session);
  }
  return [...byId.values()];
}
