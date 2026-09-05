/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatRecord,
  SlashCommandRecordPayload,
} from '../services/chatRecordingService.js';
import { parseGoalStateRecordPayloadV2 } from './goal-reducer.js';
import {
  GOAL_STATE_VERSION,
  type GoalStateRecordPayloadV2,
} from './goal-protocol.js';

export type GoalRecovery =
  | { kind: 'v2'; payload: GoalStateRecordPayloadV2 }
  | { kind: 'legacy'; objective: string }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'none' };

export type GoalRecoveryRecord = Pick<ChatRecord, 'uuid' | 'type'> & {
  subtype?: string;
  systemPayload?: unknown;
};

export interface GoalRecoverySelection {
  recovery: GoalRecovery;
  sourceUuid?: string;
}

const LEGACY_ACTIVE_KINDS = new Set(['set', 'checking']);
const LEGACY_STOPPED_KINDS = new Set([
  'achieved',
  'cleared',
  'failed',
  'aborted',
  'paused',
]);

export function recoverGoalFromRecords(
  records: readonly GoalRecoveryRecord[],
): GoalRecovery {
  return selectGoalRecoveryFromRecords(records).recovery;
}

export function selectGoalRecoveryFromRecords(
  records: readonly GoalRecoveryRecord[],
): GoalRecoverySelection {
  let unsupported: GoalRecovery | undefined;
  let unsupportedSourceUuid: string | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.subtype !== 'goal_state') continue;
    const payload =
      record.type === 'system'
        ? parseGoalStateRecordPayloadV2(record.systemPayload)
        : undefined;
    if (payload) {
      return { recovery: { kind: 'v2', payload }, sourceUuid: record.uuid };
    }
    if (!unsupported) {
      unsupported = {
        kind: 'unsupported',
        reason: `Goal lifecycle record ${record.uuid} is malformed or uses an unsupported version`,
      };
      unsupportedSourceUuid = record.uuid;
    }
  }

  return unsupported
    ? { recovery: unsupported, sourceUuid: unsupportedSourceUuid }
    : recoverLegacyGoal(records);
}

function recoverLegacyGoal(
  records: readonly GoalRecoveryRecord[],
): GoalRecoverySelection {
  for (
    let recordIndex = records.length - 1;
    recordIndex >= 0;
    recordIndex -= 1
  ) {
    const record = records[recordIndex];
    if (record?.type !== 'system' || record.subtype !== 'slash_command') {
      continue;
    }
    const payload = record.systemPayload as
      | SlashCommandRecordPayload
      | undefined;
    if (
      payload?.phase !== 'result' ||
      !Array.isArray(payload.outputHistoryItems)
    ) {
      continue;
    }
    for (
      let itemIndex = payload.outputHistoryItems.length - 1;
      itemIndex >= 0;
      itemIndex -= 1
    ) {
      const value: unknown = payload.outputHistoryItems[itemIndex];
      if (!isObjectRecord(value) || value['type'] !== 'goal_status') continue;
      const kind = value['kind'];
      const condition = value['condition'];
      if (typeof kind !== 'string' || typeof condition !== 'string') {
        return {
          recovery: unsupportedLegacy(record.uuid),
          sourceUuid: record.uuid,
        };
      }
      if (LEGACY_STOPPED_KINDS.has(kind)) {
        return { recovery: { kind: 'none' }, sourceUuid: record.uuid };
      }
      if (!LEGACY_ACTIVE_KINDS.has(kind) || condition.trim().length === 0) {
        return {
          recovery: unsupportedLegacy(record.uuid),
          sourceUuid: record.uuid,
        };
      }
      return {
        recovery: { kind: 'legacy', objective: condition.trim() },
        sourceUuid: record.uuid,
      };
    }
  }
  return { recovery: { kind: 'none' } };
}

export function normalizeGoalRecoveryRecord(
  record: GoalRecoveryRecord,
): GoalRecoveryRecord | undefined {
  if (record.subtype === 'goal_state') {
    return {
      uuid: record.uuid,
      type: record.type,
      subtype: record.subtype,
      systemPayload:
        record.type === 'system'
          ? (parseGoalStateRecordPayloadV2(record.systemPayload) ?? null)
          : null,
    };
  }
  if (record.type !== 'system' || record.subtype !== 'slash_command') {
    return undefined;
  }
  const payload = record.systemPayload as SlashCommandRecordPayload | undefined;
  if (
    payload?.phase !== 'result' ||
    !Array.isArray(payload.outputHistoryItems)
  ) {
    return undefined;
  }
  const goalStatusItems = payload.outputHistoryItems.filter(
    (value) => isObjectRecord(value) && value['type'] === 'goal_status',
  );
  if (goalStatusItems.length === 0) return undefined;
  return {
    uuid: record.uuid,
    type: record.type,
    subtype: record.subtype,
    systemPayload: {
      phase: 'result',
      outputHistoryItems: goalStatusItems,
    },
  };
}

export function isGoalRecoveryCandidate(record: GoalRecoveryRecord): boolean {
  if (record.subtype === 'goal_state') return true;
  if (record.type !== 'system' || record.subtype !== 'slash_command') {
    return false;
  }
  const payload = record.systemPayload as SlashCommandRecordPayload | undefined;
  return (
    payload?.phase === 'result' &&
    Array.isArray(payload.outputHistoryItems) &&
    payload.outputHistoryItems.some(
      (value) => isObjectRecord(value) && value['type'] === 'goal_status',
    )
  );
}

function unsupportedLegacy(recordUuid: string): GoalRecovery {
  return {
    kind: 'unsupported',
    reason: `Legacy Goal record ${recordUuid} cannot be recovered safely`,
  };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface MigratedGoalStateInput {
  objective: string;
  goalId: string;
  recordUuid: string;
  now: number;
}

export function createMigratedGoalState(
  input: MigratedGoalStateInput,
): GoalStateRecordPayloadV2 {
  const objective = input.objective.trim();
  if (!objective) {
    throw new Error('Migrated Goal objective must not be empty');
  }
  return {
    v: GOAL_STATE_VERSION,
    cause: 'migrated',
    snapshot: {
      v: GOAL_STATE_VERSION,
      activity: 'idle',
      goal: {
        goalId: input.goalId,
        revision: 1,
        objective,
        status: 'paused',
        evidenceCursor: { recordId: input.recordUuid },
        turnCount: 0,
        activeTimeMs: 0,
        tokensUsed: 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
    },
  };
}
