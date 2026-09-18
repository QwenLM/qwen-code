/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '../services/chatRecordingService.js';
import { parseGoalStateRecordPayloadV2 } from './goal-reducer.js';
import type { GoalStateRecordPayloadV2 } from './goal-protocol.js';

/**
 * What a transcript holds for the Goal runtime to restore. Only `goal_state`
 * records count: the `goal_status` cards that builds before 2026-07-29
 * (#7895) journaled are history, not state, and a session recorded by one of
 * those restores with no Goal.
 */
export type GoalRecovery =
  | { kind: 'v2'; payload: GoalStateRecordPayloadV2 }
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
    : { recovery: { kind: 'none' } };
}

/**
 * The slice of a record that Goal recovery reads, so a restore projection can
 * carry it without the rest of the record; undefined for a record recovery
 * never looks at.
 */
export function normalizeGoalRecoveryRecord(
  record: GoalRecoveryRecord,
): GoalRecoveryRecord | undefined {
  if (record.subtype !== 'goal_state') return undefined;
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

export function isGoalRecoveryCandidate(record: GoalRecoveryRecord): boolean {
  return record.subtype === 'goal_state';
}
