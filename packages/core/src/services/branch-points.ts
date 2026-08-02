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
  promptId?: string;
}

export interface BranchCandidate {
  startExclusiveRecordUuid: string | null;
  endInclusiveRecordUuid: string;
  assistantRecordUuid: string;
}

export interface BranchPoint extends BranchCandidate {
  checkpointUuid: string;
}

interface ToolCallIdentity {
  id?: string;
  name?: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parts(record: BranchPointRecord): readonly Part[] {
  return record.message?.parts ?? [];
}

function functionCalls(record: BranchPointRecord): ToolCallIdentity[] {
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

function functionResponses(record: BranchPointRecord): ToolCallIdentity[] {
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

function closeToolCall(
  pending: ToolCallIdentity[],
  response: ToolCallIdentity,
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
      if (matchingIndexes.length === 1) index = matchingIndexes[0]!;
    }
  } else if (response.name !== undefined) {
    const matchingIndexes = pending.flatMap((call, candidateIndex) =>
      call.name === response.name ? [candidateIndex] : [],
    );
    if (matchingIndexes.length === 1) index = matchingIndexes[0]!;
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
  pendingCallsAtStart: readonly ToolCallIdentity[];
}): BranchCandidate | undefined {
  const {
    activeChain,
    startIndex,
    endIndex,
    startExclusiveRecordUuid,
    pendingCallsAtStart,
  } = input;
  const pendingCalls = pendingCallsAtStart.map((call) => ({ ...call }));
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
  if (pendingCalls.length > 0) return undefined;

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

export function resolveCompletedTurnBranchCandidate(input: {
  activeChain: readonly BranchPointRecord[];
  startExclusiveRecordUuid: string | null;
  endInclusiveRecordUuid: string;
}): BranchCandidate | undefined {
  const { activeChain, startExclusiveRecordUuid, endInclusiveRecordUuid } =
    input;
  const startIndex =
    startExclusiveRecordUuid === null
      ? -1
      : activeChain.findIndex(
          (record) => record.uuid === startExclusiveRecordUuid,
        );
  const endIndex = activeChain.findIndex(
    (record) => record.uuid === endInclusiveRecordUuid,
  );
  if (
    endIndex < 0 ||
    (startExclusiveRecordUuid !== null && startIndex < 0) ||
    startIndex >= endIndex
  ) {
    return undefined;
  }

  const pendingCalls: ToolCallIdentity[] = [];
  for (let index = 0; index <= startIndex; index++) {
    const record = activeChain[index]!;
    pendingCalls.push(...functionCalls(record));
    for (const response of functionResponses(record)) {
      closeToolCall(pendingCalls, response);
    }
  }
  return resolveCompletedTurnBranchCandidateInRange({
    activeChain,
    startIndex,
    endIndex,
    startExclusiveRecordUuid,
    pendingCallsAtStart: pendingCalls,
  });
}

export function parseBranchCheckpointPayload(
  value: ChatRecord['systemPayload'],
): BranchCheckpointRecordPayloadV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const payload = value as unknown as Record<string, unknown>;
  const start = payload['startExclusiveRecordUuid'];
  const assistantRecordUuid = payload['assistantRecordUuid'];
  const promptId = payload['promptId'];
  if (
    payload['v'] !== 1 ||
    (start !== null && (typeof start !== 'string' || start.length === 0)) ||
    typeof assistantRecordUuid !== 'string' ||
    assistantRecordUuid.length === 0 ||
    (promptId !== undefined && typeof promptId !== 'string')
  ) {
    return undefined;
  }
  return {
    v: 1,
    startExclusiveRecordUuid: start,
    assistantRecordUuid,
    ...(promptId === undefined ? {} : { promptId }),
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

  const pendingCallsAtBoundary = new Map<number, ToolCallIdentity[]>();
  const pendingCalls: ToolCallIdentity[] = [];
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
