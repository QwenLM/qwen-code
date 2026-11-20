/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentDialogEntry,
  DialogEntry,
} from '../../hooks/useBackgroundTaskView.js';

// Keep this shared with keyboard focus gates: anything counted here
// must be something the live panel can actually render.
export const TERMINAL_VISIBLE_MS = 8000;

// Row budget the panel renders (it windows to the LAST rows of its
// display-ordered list when the roster outgrows this). Shared with the
// composer's panel-focus keyboard handler, which slices its candidate
// list by the same amount so `livePanelSelectedIndex` always addresses
// a row that is actually on screen. No caller overrides the panel's
// `maxRows` prop today; if one ever does, it must thread the same value
// to the keyboard handler.
export const LIVE_AGENT_PANEL_MAX_ROWS = 12;

// VP (virtualized-viewport) mode shares the terminal height with the
// conversation, so the panel uses a height-aware cap (tighter than the
// non-VP budget) to leave room for history. Referenced by both
// DefaultAppLayout (the rendered `maxRows`) and InputPrompt (the keyboard
// candidate window) so the two stay in lockstep — see
// LIVE_AGENT_PANEL_MAX_ROWS's note on the shared-window contract.
//
// Clamped to [3, 5]: at least 3 rows so the panel is useful on short
// terminals, at most 5 on tall ones.
const LIVE_AGENT_PANEL_VP_ROWS_PER_ROW = 10;
const LIVE_AGENT_PANEL_VP_MIN_ROWS = 3;
const LIVE_AGENT_PANEL_VP_MAX_ROWS_CAP = 5;

export function getLiveAgentPanelVpMaxRows(terminalHeight: number): number {
  if (!Number.isFinite(terminalHeight) || terminalHeight <= 0) {
    return LIVE_AGENT_PANEL_VP_MIN_ROWS;
  }
  return Math.max(
    LIVE_AGENT_PANEL_VP_MIN_ROWS,
    Math.min(
      LIVE_AGENT_PANEL_VP_MAX_ROWS_CAP,
      Math.floor(terminalHeight / LIVE_AGENT_PANEL_VP_ROWS_PER_ROW),
    ),
  );
}

export function isLiveAgentPanelVisibleEntry(
  entry: DialogEntry,
  nowMs: number,
): entry is AgentDialogEntry {
  if (entry.kind !== 'agent') return false;
  if (entry.status === 'running' || entry.status === 'paused') return true;
  if (entry.endTime === undefined) return false;
  return nowMs - entry.endTime <= TERMINAL_VISIBLE_MS;
}
