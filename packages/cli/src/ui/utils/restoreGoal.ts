/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  registerGoalHook,
  setGoalTerminalObserver,
  setLastGoalTerminal,
  unregisterGoalHook,
  type Config,
  type GoalTerminalEvent,
  type GoalTerminalKind,
} from '@qwen-code/qwen-code-core';
import type { HistoryItem, HistoryItemGoalStatus } from '../types.js';
import { MessageType } from '../types.js';

/**
 * Finds the most recent `goal_status` history item. Returns the active
 * condition when the latest goal event is non-terminal (`set` or `checking`),
 * or `null` if the last goal_status was terminal/cancelled
 * (achieved / cleared / aborted) or none exists.
 */
export function findGoalToRestore(history: HistoryItem[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    return goal.kind === 'set' || goal.kind === 'checking'
      ? goal.condition
      : null;
  }
  return null;
}

/**
 * Finds the most recent terminal (achieved / aborted) goal_status item in
 * the transcript. Sentinel-style entries (`set`, `cleared`, `checking`) are
 * SKIPPED — `/goal clear` after an achievement is intentionally a no-op on
 * this scan, matching Claude Code's `yjK` behavior (`if (!K.met || K.sentinel)
 * continue;`). Used on resume to repopulate the in-memory "last completed
 * goal" cache so empty `/goal` after a reload still shows the summary card.
 */
export function findLastTerminalGoal(
  history: HistoryItem[],
): GoalTerminalEvent | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    if (goal.kind !== 'achieved' && goal.kind !== 'aborted') continue;
    return {
      kind: goal.kind as GoalTerminalKind,
      condition: goal.condition,
      iterations: goal.iterations ?? 0,
      durationMs: goal.durationMs ?? 0,
      lastReason: goal.lastReason,
    };
  }
  return null;
}

type GoalStatusItem = Omit<HistoryItemGoalStatus, 'id'>;
type AddGoalStatusItem = (item: GoalStatusItem, timestamp: number) => void;

export function goalTerminalEventToHistoryItem(
  event: GoalTerminalEvent,
): GoalStatusItem {
  return {
    type: MessageType.GOAL_STATUS,
    kind: event.kind,
    condition: event.condition,
    iterations: event.iterations,
    durationMs: event.durationMs,
    lastReason: event.lastReason ?? event.systemMessage,
  };
}

export function recordGoalStatusItem(
  config: Config,
  item: GoalStatusItem,
  rawCommand = '/goal',
): void {
  try {
    config.getChatRecordingService?.()?.recordSlashCommand({
      phase: 'result',
      rawCommand,
      outputHistoryItems: [{ ...item } as Record<string, unknown>],
    });
  } catch {
    // Recording is best-effort; the live goal loop must not fail because the
    // session transcript could not be appended.
  }
}

export function installGoalTerminalObserver(args: {
  sessionId: string;
  config: Config;
  addItem: AddGoalStatusItem;
}): void {
  const { sessionId, config, addItem } = args;
  setGoalTerminalObserver(sessionId, (event: GoalTerminalEvent) => {
    const item = goalTerminalEventToHistoryItem(event);
    addItem(item, Date.now());
    recordGoalStatusItem(config, item);
  });
}

/**
 * On session resume, restores the active /goal hook if the transcript ended
 * with an unsatisfied goal. Idempotent — safe to call on a fresh session.
 *
 * Re-runs the same trust/policy gates as `/goal`; if a gate now fails, we
 * silently skip restoration rather than re-register a goal the user can no
 * longer cancel.
 */
export function restoreGoalFromHistory(
  history: HistoryItem[],
  config: Config,
  addItem?: AddGoalStatusItem,
): { restored: true; condition: string } | { restored: false } {
  const sessionId = config.getSessionId();
  // Always rehydrate the "last completed goal" cache from transcript so empty
  // `/goal` after resume can render the most recent achievement summary.
  // Independent of whether an active goal is being restored: a session may
  // have completed Goal A, started Goal B (still active), or completed
  // multiple goals — only the latest terminal one is surfaced.
  const lastTerminal = findLastTerminalGoal(history);
  setLastGoalTerminal(sessionId, lastTerminal ?? undefined);

  const condition = findGoalToRestore(history);

  if (condition === null) {
    unregisterGoalHook(config, sessionId);
    return { restored: false };
  }

  if (!config.isTrustedFolder() || config.getDisableAllHooks()) {
    unregisterGoalHook(config, sessionId);
    return { restored: false };
  }
  if (!config.getHookSystem()) {
    unregisterGoalHook(config, sessionId);
    return { restored: false };
  }

  registerGoalHook({
    config,
    sessionId,
    condition,
    tokensAtStart: 0,
  });
  if (addItem) {
    installGoalTerminalObserver({ sessionId, config, addItem });
  }
  return { restored: true, condition };
}
