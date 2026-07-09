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
  type ChatRecord,
  type Config,
  type GoalTerminalEvent,
  type GoalTerminalKind,
  type SlashCommandRecordPayload,
} from '@qwen-code/qwen-code-core';
import {
  isGoalStatusKind,
  isTerminalGoalStatusKind,
  MessageType,
  type HistoryItemGoalStatus,
  type HistoryItemWithoutId,
} from '../types.js';

/**
 * Finds the most recent `goal_status` history item. Returns the active
 * condition plus the iteration count to resume from when the latest goal event
 * is non-terminal (`set` or `checking`), or `null` if the last goal_status was
 * terminal/cancelled (achieved / failed / cleared / aborted) or none exists.
 *
 * The iteration count is carried so the MAX_GOAL_ITERATIONS safety cap survives
 * resume instead of resetting to zero. `checking` items persist the running
 * count (see useGeminiStream's continuation handler); `set` items predate any
 * iteration, so they restore at 0.
 */
export function findGoalToRestore(
  history: readonly HistoryItemWithoutId[],
): { condition: string; iterations: number } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    if (goal.kind === 'set' || goal.kind === 'checking') {
      return { condition: goal.condition, iterations: goal.iterations ?? 0 };
    }
    return null;
  }
  return null;
}

/**
 * Finds the most recent terminal (achieved / failed / aborted) goal_status item in
 * the transcript. Sentinel-style entries (`set`, `cleared`, `checking`) are
 * SKIPPED — `/goal clear` after an achievement is intentionally a no-op on
 * this scan, matching Claude Code's `yjK` behavior (`if (!K.met || K.sentinel)
 * continue;`). Used on resume to repopulate the in-memory "last completed
 * goal" cache so empty `/goal` after a reload still shows the summary card.
 */
export function findLastTerminalGoal(
  history: readonly HistoryItemWithoutId[],
): GoalTerminalEvent | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    if (!isTerminalGoalStatusKind(goal.kind)) continue;
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

export type GoalStatusItem = Omit<HistoryItemGoalStatus, 'id'>;
type AddGoalStatusItem = (item: GoalStatusItem, timestamp: number) => void;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Rebuilds a goal card from one persisted `outputHistoryItems` entry, or
 * returns null when the entry is not a well-formed goal card. Transcripts store
 * these as loose `Record<string, unknown>`, so every field is re-validated
 * rather than cast.
 */
export function parseGoalStatusItem(
  item: Record<string, unknown>,
): GoalStatusItem | null {
  if (item['type'] !== MessageType.GOAL_STATUS) return null;
  const kind = item['kind'];
  const condition = item['condition'];
  if (!isGoalStatusKind(kind) || typeof condition !== 'string') return null;

  const iterations = finiteNumber(item['iterations']);
  const setAt = finiteNumber(item['setAt']);
  const durationMs = finiteNumber(item['durationMs']);
  const lastReason =
    typeof item['lastReason'] === 'string' ? item['lastReason'] : undefined;

  return {
    type: MessageType.GOAL_STATUS,
    kind,
    condition,
    ...(iterations !== undefined ? { iterations } : {}),
    ...(setAt !== undefined ? { setAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(lastReason !== undefined ? { lastReason } : {}),
  };
}

/**
 * Extracts the goal cards a transcript persisted inside its `system` /
 * `slash_command` records, oldest first. This is the daemon-side counterpart to
 * the TUI's in-memory `HistoryItem[]`: on the ACP path no `HistoryItem[]` ever
 * exists, so `findGoalToRestore` / `findLastTerminalGoal` are fed from here.
 */
export function collectGoalStatusItemsFromRecords(
  records: readonly ChatRecord[],
): GoalStatusItem[] {
  const items: GoalStatusItem[] = [];
  for (const record of records) {
    if (record.type !== 'system' || record.subtype !== 'slash_command') {
      continue;
    }
    const payload = record.systemPayload as
      | SlashCommandRecordPayload
      | undefined;
    if (payload?.phase !== 'result') continue;
    for (const raw of payload.outputHistoryItems ?? []) {
      const item = parseGoalStatusItem(raw);
      if (item) items.push(item);
    }
  }
  return items;
}

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
  history: readonly HistoryItemWithoutId[],
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

  const restorable = findGoalToRestore(history);

  if (restorable === null) {
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
    condition: restorable.condition,
    tokensAtStart: 0,
    // Resume the iteration count so MAX_GOAL_ITERATIONS is a cross-resume cap,
    // not a per-resume one.
    initialIterations: restorable.iterations,
  });
  if (addItem) {
    installGoalTerminalObserver({ sessionId, config, addItem });
  }
  return { restored: true, condition: restorable.condition };
}
