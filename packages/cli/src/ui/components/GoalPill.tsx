/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { getActiveGoal, type ActiveGoal } from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { theme } from '../semantic-colors.js';

const POLL_INTERVAL_MS = 1000;

/**
 * Most-significant-unit elapsed string for the footer pill. Returns an empty
 * string when under 1 second so the pill collapses to just "◎ /goal active"
 * in its first second — matches Claude Code 2.1.140's footer behavior
 * (`f < 1000 ? "" : (formattedElapsed)`).
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Polls the in-memory active goal store so the footer pill reflects elapsed
 * time without coupling the store to React state. Polling is cheap (one map
 * lookup) and aligns the pill's freshness budget with the user's wall-clock
 * patience for the loop.
 */
function useActiveGoal(sessionId: string): ActiveGoal | undefined {
  const [goal, setGoal] = useState<ActiveGoal | undefined>(() =>
    getActiveGoal(sessionId),
  );
  // Re-render once per second to refresh elapsed time while a goal is active.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      const next = getActiveGoal(sessionId);
      setGoal(next);
      // Bump tick so derived strings (elapsed) recompute even when the goal
      // reference is stable.
      if (next) setTick((t) => (t + 1) % 1_000_000);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionId]);
  return goal;
}

/**
 * Hook exposed for parent containers (e.g. Footer) so they can omit the
 * surrounding divider chip entirely when no goal is active — avoids a stray
 * separator next to a render-null pill.
 */
export function useFooterGoalState(): ActiveGoal | undefined {
  const config = useConfig();
  return useActiveGoal(config.getSessionId());
}

/**
 * Compact "Goal is running" indicator for the footer. Renders nothing when no
 * goal is active. Aligned with Claude Code 2.1.140's footer pill:
 *
 *   ◎ /goal active           (during the first second)
 *   ◎ /goal active (12s)     (afterwards, most-significant unit only)
 *
 * Turns count and last-check reason are intentionally NOT in the pill — those
 * live in `/goal` status output and the `goal_status` history items so the
 * footer stays terse and stops jitter from per-iteration count flicker.
 */
export const GoalPill: React.FC = () => {
  const goal = useFooterGoalState();
  if (!goal) return null;

  const elapsed = formatElapsed(Date.now() - goal.setAt);
  const suffix = elapsed ? ` (${elapsed})` : '';
  return <Text color={theme.text.accent}>◎ /goal active{suffix}</Text>;
};
