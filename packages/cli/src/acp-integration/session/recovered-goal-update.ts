/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  GoalPersistenceUnavailableError,
  type ChatRecord,
  type GoalRecord,
  type GoalRuntime,
  type GoalSnapshotV2,
  type GoalStateCause,
} from '@qwen-code/qwen-code-core';
import type { HistoryItemGoalStatus } from '../../ui/types.js';
import {
  collectGoalStatusItemsFromRecords,
  findGoalToRestore,
} from '../../ui/utils/restoreGoal.js';
import type { HistoryReplayGoalBootstrap } from './history-replayer.js';
import {
  buildGoalStateUpdate,
  buildGoalStatusUpdate,
} from './emitters/MessageEmitter.js';

export interface RecoveredGoalUpdate {
  publicationKey?: string;
  suppressedGoalId?: string;
  updates: SessionUpdate[];
}

export async function renderPreparedGoalUpdate(
  getRuntime: () => Promise<GoalRuntime>,
  options: {
    replayedRecords?: readonly ChatRecord[];
    hideRuntimeGoal?: boolean;
    bootstrap?: HistoryReplayGoalBootstrap;
    previousGoal?: GoalRecord | null;
  } = {},
): Promise<RecoveredGoalUpdate> {
  let runtime;
  try {
    runtime = await getRuntime();
  } catch (error) {
    if (!(error instanceof GoalPersistenceUnavailableError)) throw error;
    const status = unrestorableGoalStatus(
      options.replayedRecords,
      options.bootstrap,
      UNREADABLE_GOAL_REASON,
    );
    return { updates: status ? [buildGoalStatusUpdate(status)] : [] };
  }
  const cause = runtime.getRecoveryCause?.();
  if (!cause) {
    // Nothing was recovered. A transcript from before Goal state was
    // journaled (#7895) can still end on a legacy `set` card, which a client
    // that derives the live Goal from the newest card would show as running;
    // the trailing `cleared` card says that nothing is driving it.
    const status = unrestorableGoalStatus(
      options.replayedRecords,
      options.bootstrap,
      LEGACY_GOAL_REASON,
    );
    return { updates: status ? [buildGoalStatusUpdate(status)] : [] };
  }
  const snapshot = runtime.getSnapshot();
  const publicationKey = goalPublicationKey(snapshot, cause);
  if (options.hideRuntimeGoal) {
    return {
      publicationKey,
      ...(snapshot.goal
        ? {
            suppressedGoalId: snapshot.goal.goalId,
          }
        : {}),
      updates: [],
    };
  }
  const bootstrapGoal = options.bootstrap?.goalState?.goal;
  const bootstrapMatchesRuntime =
    bootstrapGoal != null &&
    snapshot.goal?.goalId === bootstrapGoal.goalId &&
    snapshot.goal?.revision === bootstrapGoal.revision;
  return {
    publicationKey,
    updates:
      options.bootstrap && bootstrapMatchesRuntime
        ? []
        : [buildGoalStateUpdate(snapshot, cause, options.previousGoal ?? null)],
  };
}

/** Why a Goal was not restored, as the trailing card tells the user. */
export const UNREADABLE_GOAL_REASON =
  'Goal not restored: its saved state could not be read, so this session is not driving it.';
export const LEGACY_GOAL_REASON =
  'Goal not restored: it was recorded by an earlier version of Qwen Code, so this session is not driving it. Set it again with /goal set.';

export function unrestorableGoalStatus(
  replayedRecords?: readonly ChatRecord[],
  bootstrap?: HistoryReplayGoalBootstrap,
  lastReason: string = UNREADABLE_GOAL_REASON,
): Omit<HistoryItemGoalStatus, 'id' | 'type'> | undefined {
  const active =
    (replayedRecords?.length
      ? findGoalToRestore(collectGoalStatusItemsFromRecords(replayedRecords))
      : undefined) ?? bootstrap?.goalStatus;
  if (!active) return undefined;
  return {
    kind: 'cleared',
    condition: active.condition,
    iterations: active.iterations,
    ...(active.setAt !== undefined ? { setAt: active.setAt } : {}),
    lastReason,
  };
}

export function goalPublicationKey(
  snapshot: GoalSnapshotV2,
  cause?: GoalStateCause,
): string | undefined {
  return cause ? `${cause}:${JSON.stringify(snapshot)}` : undefined;
}
