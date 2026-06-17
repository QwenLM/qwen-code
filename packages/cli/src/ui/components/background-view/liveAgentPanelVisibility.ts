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
