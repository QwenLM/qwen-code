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
import { writeStderrLine } from '../../utils/stdioHelpers.js';

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
 * count (see useGeminiStream's continuation handler); `set` items predate any
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
 * on the `set` card that opened this run. Any other kind ends the run, so the
 * scan stops there rather than picking up a previous goal's start time.
 */
function findSetAtOfRun(
  history: readonly HistoryItemWithoutId[],
  startIndex: number,
): number | undefined {
  for (let i = startIndex - 1; i >= 0; i--) {
    const item = history[i];
    if (item?.type !== MessageType.GOAL_STATUS) continue;
    const goal = item as HistoryItemGoalStatus;
    if (goal.kind !== 'set' && goal.kind !== 'checking') return undefined;
    if (goal.setAt !== undefined) return goal.setAt;
  }
  return undefined;
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
    const recording = config.getChatRecordingService?.();
    if (!recording) {
      // Optional chaining used to swallow this. A goal set without a recording
      // service works for the rest of the session and then vanishes on resume,
      // which is indistinguishable from the restore bug this module fixes.
      writeStderrLine(
        `qwen: no chat recording service; goal_status (kind=${item.kind}) will not survive a resume.`,
      );
      return;
    }
    recording.recordSlashCommand({
      phase: 'result',
      rawCommand,
      outputHistoryItems: [{ ...item } as Record<string, unknown>],
    });
  } catch (error) {
    // Recording is best-effort; the live goal loop must not fail because the
    // session transcript could not be appended. But swallowing it silently is
    // how a goal ends up unrecoverable on resume — the failure mode this
    // recording exists to prevent — so leave a trace.
    // Not debugLogger: that no-ops unless a debug session is active, and a
    // lost write here is invisible until the goal fails to survive a resume.
    writeStderrLine(
      `qwen: failed to record goal_status (kind=${item.kind}): ${error}`,
    );
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
 * Why a transcript's active goal could not be put back under a live Stop hook.
 * `condition-invalid` covers a transcript that no longer describes a goal
 * `/goal` itself would accept.
 */
export type GoalRestoreBlockedReason =
  | 'untrusted-folder'
  | 'hooks-disabled'
  | 'no-hook-system'
  | 'condition-invalid';

/**
 * The environment half of `/goal`'s gates, as a pure function of `config`.
 *
 * Split out so the history replay can ask the question *before* restore runs:
 * a client derives "there is an active goal" from the newest replayed goal
 * card, so a card that is about to be refused must not be replayed as active.
 */
export function goalRestoreBlockedBy(
  config: Config,
): Exclude<GoalRestoreBlockedReason, 'condition-invalid'> | null {
  if (!config.isTrustedFolder()) return 'untrusted-folder';
  if (config.getDisableAllHooks()) return 'hooks-disabled';
  if (!config.getHookSystem()) return 'no-hook-system';
  return null;
}

/**
 * Mirrors the gates `/goal` applies to a condition at set time.
 *
 * There is deliberately no length cap: #6665 removed the one `/goal` had, so
 * capping here would silently destroy a long goal the user legitimately set —
 * refused on restore, and dropped from the replay so they never see why.
 */
export function goalConditionBlockedBy(
  condition: string,
): 'condition-invalid' | null {
  if (condition.length === 0) return 'condition-invalid';
  return null;
}

export type RestoreGoalResult =
  | { restored: true; condition: string }
  | { restored: false; blockedBy?: GoalRestoreBlockedReason };

/**
 * On session resume, restores the active /goal hook if the transcript ended
 * with an unsatisfied goal. Idempotent — safe to call on a fresh session.
 *
 * Re-runs the same trust/policy/length gates as `/goal`; if a gate now fails,
 * we skip restoration rather than re-register a goal the user can no longer
 * cancel. That case reports `blockedBy`, which callers must not confuse with
 * "the transcript had no goal": the transcript still shows one as active, so
 * something has to say otherwise.
 *
 * Note that every `{ restored: false }` path unregisters, which clears the
 * session's goal-terminal observer as a side effect. ACP callers reinstall it.
 */
export function restoreGoalFromHistory(
  history: readonly HistoryItemWithoutId[],
  config: Config,
  addItem?: AddGoalStatusItem,
): RestoreGoalResult {
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

  const blockedBy = goalRestoreBlockedBy(config);
  if (blockedBy) {
    unregisterGoalHook(config, sessionId);
    return { restored: false, blockedBy };
  }
  // `/goal` gates the condition at set time, but a transcript is a file: a
  // corrupted or hand-edited `condition` would otherwise be re-registered —
  // empty and meaningless — and then embedded verbatim in every judge call and
  // continuation prompt for the rest of the session.
  if (goalConditionBlockedBy(restorable.condition)) {
    writeStderrLine(
      'qwen: refusing to restore a goal whose condition is empty.',
    );
    unregisterGoalHook(config, sessionId);
    return { restored: false, blockedBy: 'condition-invalid' };
  }

  registerGoalHook({
    config,
    sessionId,
    condition: restorable.condition,
    tokensAtStart: 0,
    // Resume the iteration count so MAX_GOAL_ITERATIONS is a cross-resume cap,
    // not a per-resume one.
    initialIterations: restorable.iterations,
    // Likewise the start time: without it every reload restarts the clock, and
    // `GET /goals` reports a long-running goal as freshly started.
    ...(restorable.setAt !== undefined
      ? { initialSetAt: restorable.setAt }
      : {}),
  });
  if (addItem) {
    installGoalTerminalObserver({ sessionId, config, addItem });
  }
  return { restored: true, condition: restorable.condition };
}
