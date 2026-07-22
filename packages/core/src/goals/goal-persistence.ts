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

const LEGACY_ACTIVE_KINDS = new Set(['set', 'checking']);
const LEGACY_STOPPED_KINDS = new Set([
  'achieved',
  'cleared',
  'failed',
  'aborted',
]);

export function recoverGoalFromRecords(
  records: readonly GoalRecoveryRecord[],
): GoalRecovery {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record?.subtype !== 'goal_state') continue;
    const payload =
      record.type === 'system'
        ? parseGoalStateRecordPayloadV2(record.systemPayload)
        : undefined;
    return payload
      ? { kind: 'v2', payload }
      : {
          kind: 'unsupported',
          reason: `Goal lifecycle record ${record.uuid} is malformed or uses an unsupported version`,
        };
  }

  return recoverLegacyGoal(records);
}

function recoverLegacyGoal(
  records: readonly GoalRecoveryRecord[],
): GoalRecovery {
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
        return unsupportedLegacy(record.uuid);
      }
      if (LEGACY_STOPPED_KINDS.has(kind)) return { kind: 'none' };
      if (!LEGACY_ACTIVE_KINDS.has(kind) || condition.trim().length === 0) {
        return unsupportedLegacy(record.uuid);
      }
      return { kind: 'legacy', objective: condition.trim() };
    }
  }
  return { kind: 'none' };
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
  return {
    v: GOAL_STATE_VERSION,
    cause: 'migrated',
    snapshot: {
      v: GOAL_STATE_VERSION,
      activity: 'idle',
      goal: {
        goalId: input.goalId,
        revision: 1,
        objective: input.objective.trim(),
        status: 'active',
        evidenceCursor: { recordId: input.recordUuid },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: input.now,
        updatedAt: input.now,
      },
    },
  };
}
