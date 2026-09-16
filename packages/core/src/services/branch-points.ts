/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';

export type BranchPointRecord = Pick<
  ChatRecord,
  'uuid' | 'parentUuid' | 'type' | 'subtype' | 'message' | 'systemPayload'
>;

export interface BranchCheckpointRecordPayloadV1 {
  v: 1;
  startExclusiveRecordUuid: string | null;
  assistantRecordUuid: string;
}

interface BranchCandidate {
  startExclusiveRecordUuid: string | null;
  endInclusiveRecordUuid: string;
  assistantRecordUuid: string;
}

export interface BranchPoint extends BranchCandidate {
  checkpointUuid: string;
}

export interface BranchToolCallIdentity {
  id?: string;
  name?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parts(record: BranchPointRecord): readonly Part[] {
  // Transcript JSONL can contain null part elements; validation only checks
  // that parts is an array, so skip non-object entries before dereferencing.
  return ((record.message?.parts ?? []) as unknown[]).filter(
    (part): part is Part => part !== null && typeof part === 'object',
  );
}

function functionCalls(record: BranchPointRecord): BranchToolCallIdentity[] {
  return parts(record).flatMap((part) => {
    const call = part.functionCall;
    if (!call) return [];
    return [
      {
        ...(nonEmptyString(call.id) ? { id: call.id } : {}),
        ...(nonEmptyString(call.name) ? { name: call.name } : {}),
      },
    ];
  });
}

function functionResponses(
  record: BranchPointRecord,
): BranchToolCallIdentity[] {
  return parts(record).flatMap((part) => {
    const response = part.functionResponse;
    if (!response) return [];
    return [
      {
        ...(nonEmptyString(response.id) ? { id: response.id } : {}),
        ...(nonEmptyString(response.name) ? { name: response.name } : {}),
      },
    ];
  });
}

function hasVisibleText(record: BranchPointRecord): boolean {
  return parts(record).some(
    (part) =>
      part.thought !== true &&
      typeof part.text === 'string' &&
      part.text.trim().length > 0,
  );
}

interface PendingToolCall extends BranchToolCallIdentity {
  carriedFromPrefix?: boolean;
}

function uniqueNameMatch(
  pending: readonly PendingToolCall[],
  matchingIndexes: number[],
): number {
  if (matchingIndexes.length === 1) return matchingIndexes[0]!;
  // A dangling call carried in from the pre-boundary prefix must not veto a
  // unique in-interval match, or a crashed earlier turn would permanently
  // disable checkpoints for later turns using the same tool.
  const freshIndexes = matchingIndexes.filter(
    (candidateIndex) => pending[candidateIndex]?.carriedFromPrefix !== true,
  );
  return freshIndexes.length === 1 ? freshIndexes[0]! : -1;
}

function closeToolCall(
  pending: PendingToolCall[],
  response: BranchToolCallIdentity,
): boolean {
  let index = -1;
  if (response.id !== undefined) {
    index = pending.findIndex((call) => call.id === response.id);
    if (index < 0 && response.name !== undefined) {
      const matchingIndexes = pending.flatMap((call, candidateIndex) =>
        call.id === undefined && call.name === response.name
          ? [candidateIndex]
          : [],
      );
      index = uniqueNameMatch(pending, matchingIndexes);
    }
  } else if (response.name !== undefined) {
    const matchingIndexes = pending.flatMap((call, candidateIndex) =>
      call.name === response.name ? [candidateIndex] : [],
    );
    index = uniqueNameMatch(pending, matchingIndexes);
  }
  if (index < 0) return false;
  pending.splice(index, 1);
  return true;
}

function resolveCompletedTurnBranchCandidateInRange(input: {
  activeChain: readonly BranchPointRecord[];
  startIndex: number;
  endIndex: number;
  startExclusiveRecordUuid: string | null;
  pendingCallsAtStart: readonly BranchToolCallIdentity[];
}): BranchCandidate | undefined {
  const {
    activeChain,
    startIndex,
    endIndex,
    startExclusiveRecordUuid,
    pendingCallsAtStart,
  } = input;
  // A dangling call carried in from the pre-boundary prefix (a crashed turn
  // that never wrote its tool_result) must not permanently disable later
  // checkpoints; only calls issued inside the interval must close.
  const pendingCalls: PendingToolCall[] = pendingCallsAtStart.map((call) => ({
    ...call,
    carriedFromPrefix: true,
  }));
  let lastToolResultIndex = startIndex;
  for (let index = startIndex + 1; index <= endIndex; index++) {
    const record = activeChain[index]!;
    pendingCalls.push(...functionCalls(record));
    const responses = functionResponses(record);
    if (record.type === 'tool_result' || responses.length > 0) {
      lastToolResultIndex = index;
    }
    for (const response of responses) {
      if (!closeToolCall(pendingCalls, response)) return undefined;
    }
  }
  if (pendingCalls.some((call) => !call.carriedFromPrefix)) return undefined;

  let assistantRecordUuid: string | undefined;
  for (let index = lastToolResultIndex + 1; index <= endIndex; index++) {
    const record = activeChain[index]!;
    if (
      record.type !== 'assistant' ||
      functionCalls(record).length > 0 ||
      !hasVisibleText(record)
    ) {
      continue;
    }
    if (assistantRecordUuid !== undefined) return undefined;
    assistantRecordUuid = record.uuid;
  }
  if (assistantRecordUuid === undefined) return undefined;

  return {
    startExclusiveRecordUuid,
    endInclusiveRecordUuid: activeChain[endIndex]!.uuid,
    assistantRecordUuid,
  };
}

export function updatePendingBranchToolCalls(
  pendingCalls: BranchToolCallIdentity[],
  record: BranchPointRecord,
): void {
  pendingCalls.push(...functionCalls(record));
  for (const response of functionResponses(record)) {
    closeToolCall(pendingCalls, response);
  }
}

export function collectPendingBranchToolCalls(
  records: readonly BranchPointRecord[],
): BranchToolCallIdentity[] {
  const pendingCalls: BranchToolCallIdentity[] = [];
  for (const record of records) {
    updatePendingBranchToolCalls(pendingCalls, record);
  }
  return pendingCalls;
}

export function resolveCompletedTurnBranchCandidateFromRecords(input: {
  records: readonly BranchPointRecord[];
  startExclusiveRecordUuid: string | null;
  pendingCallsAtStart: readonly BranchToolCallIdentity[];
}): BranchCandidate | undefined {
  if (input.records.length === 0) return undefined;
  return resolveCompletedTurnBranchCandidateInRange({
    activeChain: input.records,
    startIndex: -1,
    endIndex: input.records.length - 1,
    startExclusiveRecordUuid: input.startExclusiveRecordUuid,
    pendingCallsAtStart: input.pendingCallsAtStart,
  });
}

export function parseBranchCheckpointPayload(
  value: ChatRecord['systemPayload'],
): BranchCheckpointRecordPayloadV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const payload = value as unknown as Record<string, unknown>;
  const start = payload['startExclusiveRecordUuid'];
  const assistantRecordUuid = payload['assistantRecordUuid'];
  if (
    payload['v'] !== 1 ||
    (start !== null && (typeof start !== 'string' || start.length === 0)) ||
    typeof assistantRecordUuid !== 'string' ||
    assistantRecordUuid.length === 0
  ) {
    return undefined;
  }
  return {
    v: 1,
    startExclusiveRecordUuid: start,
    assistantRecordUuid,
  };
}

export function resolveBranchPoints(
  activeChain: readonly BranchPointRecord[],
): ReadonlyMap<string, BranchPoint> {
  const points = new Map<string, BranchPoint>();
  const recordIndexes = new Map<string, number>();
  for (let index = 0; index < activeChain.length; index++) {
    const record = activeChain[index]!;
    if (
      typeof record.uuid !== 'string' ||
      record.uuid.length === 0 ||
      recordIndexes.has(record.uuid)
    ) {
      return points;
    }
    recordIndexes.set(record.uuid, index);
  }

  const checkpoints: Array<{
    checkpoint: BranchPointRecord;
    checkpointIndex: number;
    startIndex: number;
    payload: BranchCheckpointRecordPayloadV1;
  }> = [];
  const boundaryIndexes = new Set<number>();
  for (let index = 0; index < activeChain.length; index++) {
    const checkpoint = activeChain[index]!;
    if (
      checkpoint.type !== 'system' ||
      checkpoint.subtype !== 'branch_checkpoint' ||
      checkpoint.parentUuid === null ||
      activeChain[index - 1]?.uuid !== checkpoint.parentUuid
    ) {
      continue;
    }
    const payload = parseBranchCheckpointPayload(checkpoint.systemPayload);
    if (!payload) continue;
    const startIndex =
      payload.startExclusiveRecordUuid === null
        ? -1
        : (recordIndexes.get(payload.startExclusiveRecordUuid) ?? -1);
    if (
      payload.startExclusiveRecordUuid !== null &&
      (startIndex < 0 || startIndex >= index - 1)
    ) {
      continue;
    }
    checkpoints.push({
      checkpoint,
      checkpointIndex: index,
      startIndex,
      payload,
    });
    if (startIndex >= 0) boundaryIndexes.add(startIndex);
  }

  const pendingCallsAtBoundary = new Map<number, BranchToolCallIdentity[]>();
  const pendingCalls: BranchToolCallIdentity[] = [];
  for (let index = 0; index < activeChain.length; index++) {
    const record = activeChain[index]!;
    pendingCalls.push(...functionCalls(record));
    for (const response of functionResponses(record)) {
      closeToolCall(pendingCalls, response);
    }
    if (boundaryIndexes.has(index)) {
      pendingCallsAtBoundary.set(
        index,
        pendingCalls.map((call) => ({ ...call })),
      );
    }
  }

  const checkpointByAssistantUuid = new Map<string, string>();
  for (const {
    checkpoint,
    checkpointIndex,
    startIndex,
    payload,
  } of checkpoints) {
    const candidate = resolveCompletedTurnBranchCandidateInRange({
      activeChain,
      startIndex,
      endIndex: checkpointIndex - 1,
      startExclusiveRecordUuid: payload.startExclusiveRecordUuid,
      pendingCallsAtStart:
        startIndex < 0 ? [] : (pendingCallsAtBoundary.get(startIndex) ?? []),
    });
    if (
      !candidate ||
      candidate.assistantRecordUuid !== payload.assistantRecordUuid
    ) {
      continue;
    }
    const previousCheckpoint = checkpointByAssistantUuid.get(
      candidate.assistantRecordUuid,
    );
    if (previousCheckpoint !== undefined) {
      points.delete(previousCheckpoint);
      continue;
    }
    points.set(checkpoint.uuid, {
      ...candidate,
      checkpointUuid: checkpoint.uuid,
    });
    checkpointByAssistantUuid.set(
      candidate.assistantRecordUuid,
      checkpoint.uuid,
    );
  }
  return points;
}
