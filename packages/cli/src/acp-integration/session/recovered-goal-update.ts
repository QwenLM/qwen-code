/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionUpdate } from '@agentclientprotocol/sdk';
import {
  findRunningLegacyGoalCard,
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
    );
    return { updates: status ? [buildGoalStatusUpdate(status)] : [] };
  }
  const cause = runtime.getRecoveryCause?.();
  const snapshot = runtime.getSnapshot();
  if (!cause) {
    const status = legacyGoalSupersession(snapshot, options.replayedRecords);
    return { updates: status ? [buildGoalStatusUpdate(status)] : [] };
  }
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

/**
 * The trailing `cleared` card for a Goal a build before #7895 recorded as a
 * running card, which this build does not restore.
 *
 * Nothing is wrong with the transcript and nothing was recovered, so this is
 * the one place that says the card is not a running Goal. Emitted only when
 * the runtime drives no Goal and the replay's newest Goal record is that
 * card: a Goal set after the resume, or any `goal_state` record after the
 * card, means a journaling build has had the last word and the card is
 * history the replay already showed as such.
 */
export function legacyGoalSupersession(
  snapshot: GoalSnapshotV2,
  replayedRecords: readonly ChatRecord[] | undefined,
): Omit<HistoryItemGoalStatus, 'id' | 'type'> | undefined {
  if (snapshot.goal !== null || !replayedRecords?.length) return undefined;
  const card = findRunningLegacyGoalCard(replayedRecords);
  if (!card) return undefined;
  return {
    kind: 'cleared',
    condition: card.condition,
    iterations: card.iterations,
    ...(card.setAt !== undefined ? { setAt: card.setAt } : {}),
    lastReason: LEGACY_GOAL_REASON,
  };
}

/**
 * The trailing `cleared` card for a Goal whose saved state could not be
 * read, so that the running card the replay ended on is not the last word.
 */
export function unrestorableGoalStatus(
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
    lastReason: UNREADABLE_GOAL_REASON,
  };
}

export function goalPublicationKey(
  snapshot: GoalSnapshotV2,
  cause?: GoalStateCause,
): string | undefined {
  return cause ? `${cause}:${JSON.stringify(snapshot)}` : undefined;
}
