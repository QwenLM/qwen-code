/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalRecoveryRecord,
  SlashCommandRecordPayload,
} from '@qwen-code/qwen-code-core';
import {
  isGoalStatusKind,
  MessageType,
  type HistoryItemGoalStatus,
  type HistoryItemWithoutId,
} from '../types.js';

export interface RestorableGoal {
  condition: string;
  iterations: number;
  /** Absent when no card of this goal's run carried one. */
  setAt?: number;
}

/**
 * Finds the most recent `goal_status` history item. Returns the active
 * condition plus the iteration count to resume from when the latest goal event
 * is non-terminal (`set` or `checking`), or `null` if the last goal_status was
 * terminal/cancelled (achieved / failed / cleared / aborted) or none exists.
 *
 * The iteration count is carried so the MAX_GOAL_ITERATIONS safety cap survives
 * resume instead of resetting to zero. `checking` items persist the running
 * count (see useLlmStream's continuation handler); `set` items predate any
 * iteration, so they restore at 0.
 *
 * `setAt` is carried so elapsed time keeps measuring from the original `/goal`.
 * The newest card is not necessarily the one that has it — only `set` cards are
 * written with a `setAt` — so we keep scanning back through this same run's
 * cards for it, stopping at the terminal card that ends the previous run.
 */
export function findGoalToRestore(
  history: readonly HistoryItemWithoutId[],
): RestorableGoal | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    if (goal.kind !== 'set' && goal.kind !== 'checking') return null;
    const setAt = goal.setAt ?? findSetAtOfRun(history, i);
    return {
      condition: goal.condition,
      iterations: goal.iterations ?? 0,
      ...(setAt !== undefined ? { setAt } : {}),
    };
  }
  return null;
}

/**
 * Walks back from the active goal card at `startIndex` for the `setAt` stamped
 * on the `set` card that opened this run.
 *
 * A run ends at any card that is not `set`/`checking` — but that alone is not
 * enough to stay inside it. A transcript is a file: two goals can sit back to
 * back with no terminal card between them (hand-edited, truncated, or written
 * by a version that did not persist terminal cards). The condition is what
 * actually identifies the run, so the scan stops as soon as it changes rather
 * than walking into the previous goal and returning *its* start time.
 */
function findSetAtOfRun(
  history: readonly HistoryItemWithoutId[],
  startIndex: number,
): number | undefined {
  const start = history[startIndex] as HistoryItemGoalStatus | undefined;
  const condition = start?.condition;
  for (let i = startIndex - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    if (goal.kind !== 'set' && goal.kind !== 'checking') return undefined;
    if (goal.condition !== condition) return undefined;
    if (goal.setAt !== undefined) return goal.setAt;
  }
  return undefined;
}

export type GoalStatusItem = Omit<HistoryItemGoalStatus, 'id'>;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Narrows one untrusted `outputHistoryItems` entry before any field is read.
 * A transcript is a file: an entry may be any JSON value, and only a plain
 * object is safely indexable.
 */
export function isTranscriptItemRecord(
  item: unknown,
): item is Record<string, unknown> {
  return typeof item === 'object' && item !== null && !Array.isArray(item);
}

/**
 * Rebuilds a goal card from one persisted `outputHistoryItems` entry, or
 * returns null when the entry is not a well-formed goal card. Transcripts are
 * files on disk: an entry may be any JSON value at all — including `null` or an
 * array — so the shape is checked before any field is read, and then every
 * field is re-validated rather than cast.
 */
export function parseGoalStatusItem(item: unknown): GoalStatusItem | null {
  if (!isTranscriptItemRecord(item)) return null;
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
 * exists, so `findGoalToRestore` is fed from here.
 */
export function collectGoalStatusItemsFromRecords(
  records: readonly GoalRecoveryRecord[],
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
    // The type says `outputHistoryItems?: Record<string, unknown>[]`, but the
    // value came off disk. A hand-edited record that made it a plain object
    // would throw here and take the whole restore down with it — including the
    // valid goal cards further along.
    const raws: unknown = payload.outputHistoryItems;
    if (!Array.isArray(raws)) continue;
    for (const raw of raws) {
      const item = parseGoalStatusItem(raw);
      if (item) items.push(item);
    }
  }
  return items;
}
