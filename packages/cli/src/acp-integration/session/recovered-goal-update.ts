/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type {
  GoalRecord,
  GoalSnapshotV2,
  GoalStateCause,
} from '@qwen-code/qwen-code-core/goals/goal-protocol.js';
import { GoalPersistenceUnavailableError } from '@qwen-code/qwen-code-core/goals/goal-runtime.js';
import type { GoalRuntime } from '@qwen-code/qwen-code-core/goals/goal-runtime.js';
import type { ChatRecord } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
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
    );
    return { updates: status ? [buildGoalStatusUpdate(status)] : [] };
  }
  const cause = runtime.getRecoveryCause?.();
  if (!cause) return { updates: [] };
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

function unrestorableGoalStatus(
  replayedRecords?: readonly ChatRecord[],
  bootstrap?: HistoryReplayGoalBootstrap,
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
    lastReason:
      'Goal not restored: its saved state could not be read, so this session is not driving it.',
  };
}

export function goalPublicationKey(
  snapshot: GoalSnapshotV2,
  cause?: GoalStateCause,
): string | undefined {
  return cause ? `${cause}:${JSON.stringify(snapshot)}` : undefined;
}
