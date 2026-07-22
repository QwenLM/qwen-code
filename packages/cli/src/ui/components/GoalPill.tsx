/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { elapsedActiveTime } from '@qwen-code/qwen-code-core';
import type {
  Config,
  GoalRuntime,
  GoalSnapshotV2,
} from '@qwen-code/qwen-code-core';
import { useConfig } from '../contexts/ConfigContext.js';
import { theme } from '../semantic-colors.js';

const ELAPSED_REFRESH_MS = 1000;

function formatElapsed(ms: number): string {
  if (ms < 1000) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function getRuntime(config: Config): GoalRuntime | null {
  if (typeof config.getGoalRuntime !== 'function') return null;
  try {
    return config.getGoalRuntime();
  } catch {
    return null;
  }
}

/**
 * Subscribes to the canonical runtime owned by the current Config session.
 * The session id is a dependency because Config replaces its runtime in place
 * when a resume or branch operation switches sessions.
 */
export function useFooterGoalState(): GoalSnapshotV2 | undefined {
  const config = useConfig();
  const sessionId = config.getSessionId();
  const runtime = getRuntime(config);
  const [observed, setObserved] = useState<{
    runtime: GoalRuntime | null;
    snapshot?: GoalSnapshotV2;
  }>(() => ({
    runtime,
    snapshot: runtime?.getSnapshot(),
  }));

  useEffect(() => {
    if (!runtime) {
      setObserved({ runtime });
      return;
    }

    setObserved({ runtime, snapshot: runtime.getSnapshot() });
    return runtime.subscribe((snapshot) => {
      setObserved({ runtime, snapshot });
    });
  }, [runtime, sessionId]);

  return observed.runtime === runtime
    ? observed.snapshot
    : runtime?.getSnapshot();
}

export function isLiveGoalSnapshot(
  snapshot: GoalSnapshotV2 | undefined,
): boolean {
  const status = snapshot?.goal?.status;
  return status !== undefined && status !== 'complete';
}

function presentation(snapshot: GoalSnapshotV2): {
  icon: string;
  label: string;
  color: string;
} | null {
  const goal = snapshot.goal;
  if (!goal || goal.status === 'complete') return null;

  if (goal.status === 'active') {
    return snapshot.activity === 'verifying'
      ? { icon: '○', label: 'checking', color: theme.text.secondary }
      : { icon: '◎', label: 'active', color: theme.text.accent };
  }
  switch (goal.status) {
    case 'paused':
      return { icon: '!', label: 'paused', color: theme.status.warning };
    case 'blocked':
      return { icon: '✖', label: 'blocked', color: theme.status.error };
    case 'usage_limited':
      return {
        icon: '!',
        label: 'usage limited',
        color: theme.status.warning,
      };
    default: {
      const exhaustive: never = goal.status;
      void exhaustive;
      return null;
    }
  }
}

export interface GoalPillProps {
  snapshot: GoalSnapshotV2 | undefined;
}

/** Compact live lifecycle indicator for the existing Ink footer. */
export const GoalPill: React.FC<GoalPillProps> = ({ snapshot }) => {
  const [, setTick] = useState(0);
  const refreshElapsed = snapshot?.goal?.status === 'active';
  useEffect(() => {
    if (!refreshElapsed) return;
    const interval = setInterval(() => {
      setTick((tick) => (tick + 1) % 1_000_000);
    }, ELAPSED_REFRESH_MS);
    return () => clearInterval(interval);
  }, [refreshElapsed]);

  if (!snapshot) return null;
  const goal = snapshot.goal;
  if (!goal) return null;
  const visible = presentation(snapshot);
  if (!visible) return null;

  const elapsed = formatElapsed(elapsedActiveTime(goal, Date.now()));
  const suffix = elapsed ? ` (${elapsed})` : '';
  return (
    <Text color={visible.color}>
      {visible.icon} /goal {visible.label}
      {suffix}
    </Text>
  );
};
