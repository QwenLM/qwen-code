/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonCapabilities,
  DaemonSessionGroupPresetColor,
} from '@qwen-code/sdk/daemon';

// Reuse the sidebar session-group palette so a workspace's accent speaks the
// same visual language as the group dots (see WebShellSidebar.module.css /
// SessionOverviewPanel.module.css, which mirror the same six presets). Ordered
// for contrast in the common two/three-workspace split — the first picks are
// the most distinct — and cycled once a daemon has more than six workspaces.
const WORKSPACE_ACCENT_COLORS: readonly DaemonSessionGroupPresetColor[] = [
  'blue',
  'green',
  'purple',
  'orange',
  'yellow',
  'red',
];

// A cheap deterministic string hash, only used when a cwd isn't in the
// advertised `workspaces[]` yet (e.g. a pane whose runtime resolves after
// mount), so its accent still stays stable across renders instead of flickering.
function hashCwd(cwd: string): number {
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) {
    hash = (hash * 31 + cwd.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * A stable accent color for a workspace, so split-view panes in the same
 * workspace share a color and different workspaces read apart at a glance.
 * Keyed by the workspace's position in the daemon's `workspaces[]` (stable per
 * daemon), so the primary workspace always gets the first color; falls back to
 * a deterministic hash of the cwd when the list doesn't include it. Returns
 * `undefined` for a missing cwd so callers can skip the accent entirely.
 */
export function workspaceAccentColor(
  cwd: string | undefined,
  capabilities: DaemonCapabilities | undefined,
): DaemonSessionGroupPresetColor | undefined {
  if (!cwd) return undefined;
  const workspaces = capabilities?.workspaces ?? [];
  const index = workspaces.findIndex((workspace) => workspace.cwd === cwd);
  const slot = index >= 0 ? index : hashCwd(cwd);
  return WORKSPACE_ACCENT_COLORS[slot % WORKSPACE_ACCENT_COLORS.length];
}
