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

export function isLiveAgentPanelVisibleEntry(
  entry: DialogEntry,
  nowMs: number,
): entry is AgentDialogEntry {
  if (entry.kind !== 'agent') return false;
  if (entry.status === 'running' || entry.status === 'paused') return true;
  if (entry.endTime === undefined) return false;
  return nowMs - entry.endTime <= TERMINAL_VISIBLE_MS;
}

/**
 * A stable signature of everything that changes the LiveAgentPanel's
 * **height** (and therefore the controls footprint that AppContainer reserves
 * via `availableTerminalHeight`).
 *
 * The panel renders only agent-kind entries; their count and status
 * (running / paused / terminal) drive the row count + the "N more above"
 * overflow line, and the focus flag adds a navigation-hint row. Crucially the
 * panel's per-second elapsed-time tick (`LiveAgentPanel`'s internal `setNow`)
 * does NOT flow through the roster, so this key stays stable across those
 * ticks — only genuine roster growth/shrink or focus changes alter it.
 *
 * AppContainer feeds this key into its `controlsHeight` measurement effect so
 * the footer is re-measured exactly when the panel can grow. Without it, an
 * agent launching grows the panel below the composer but `controlsHeight`
 * stays stale, `availableTerminalHeight` is left too large, the pending region
 * overflows the terminal, and (in non-VP mode) every repaint forces the
 * terminal back to the bottom with a flicker.
 *
 * Time-based eviction (a finished agent's row disappearing after 8s) only
 * SHRINKS the panel and is intentionally not captured here — a stale, slightly
 * too-large reservation over-clips the pending region, which is the safe
 * direction (no overflow).
 */
export function getLiveAgentPanelLayoutKey(
  entries: readonly DialogEntry[],
  livePanelFocused: boolean,
): string {
  let key = livePanelFocused ? 'f' : '_';
  for (const entry of entries) {
    if (entry.kind !== 'agent') continue;
    key += `|${entry.agentId}:${entry.status}`;
  }
  return key;
}
