/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonCapabilities,
  DaemonSessionGroupPresetColor,
} from '@qwen-code/sdk/daemon';
import accentStyles from '../components/WorkspaceAccent.module.css';

// Reuse the sidebar session-group palette so a workspace's accent speaks the
// same visual language as the group dots (see WebShellSidebar.module.css /
// SessionOverviewPanel.module.css, which mirror the same six presets). Ordered
// for contrast in the common two/three-workspace split — the first picks are
// the most distinct — and cycled once a daemon has more than six workspaces.
const WORKSPACE_ACCENT_COLORS = [
  'blue',
  'green',
  'purple',
  'orange',
  'yellow',
  'red',
] as const satisfies readonly DaemonSessionGroupPresetColor[];

// Compile-time exhaustiveness guard: every DaemonSessionGroupPresetColor must
// appear in the list above (and have a matching class in
// WorkspaceAccent.module.css). Adding a preset color to the type without
// extending this list fails to compile here — instead of silently dropping
// that color's accent (accentStyles[color] → undefined) at runtime.
type AssertNever<T extends never> = T;
type _AccentColorsAreExhaustive = AssertNever<
  Exclude<
    DaemonSessionGroupPresetColor,
    (typeof WORKSPACE_ACCENT_COLORS)[number]
  >
>;

// Dev-only runtime companion to the compile-time guard above: the guard proves
// every color is listed, but CSS modules are typed as `Record<string, string>`,
// so a renamed or removed class in WorkspaceAccent.module.css would still slip
// through as `accentStyles[color] === undefined` — a silent missing accent with
// no error. Fail loudly in dev instead. Stripped from production builds.
if (import.meta.env.DEV) {
  for (const color of WORKSPACE_ACCENT_COLORS) {
    if (!accentStyles[color]) {
      throw new Error(
        `WorkspaceAccent.module.css is missing a class for the "${color}" accent`,
      );
    }
  }
}

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
