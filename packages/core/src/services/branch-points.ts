/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';

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

function parts(record: ChatRecord): readonly Part[] {
  return record.message?.parts ?? [];
}

function functionCalls(record: ChatRecord): ToolCallIdentity[] {
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

function functionResponses(record: ChatRecord): ToolCallIdentity[] {
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

function hasVisibleText(record: ChatRecord): boolean {
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

export function resolveCompletedTurnBranchCandidate(input: {
  activeChain: readonly ChatRecord[];
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

  const interval = activeChain.slice(startIndex + 1, endIndex + 1);
  const pendingCalls: ToolCallIdentity[] = [];
  for (const record of activeChain.slice(0, startIndex + 1)) {
    pendingCalls.push(...functionCalls(record));
    for (const response of functionResponses(record)) {
      closeToolCall(pendingCalls, response);
    }
  }
  let lastToolResultIndex = -1;
  for (let index = 0; index < interval.length; index++) {
    const record = interval[index]!;
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

  const candidates = interval.filter(
    (record, index) =>
      index > lastToolResultIndex &&
      record.type === 'assistant' &&
      functionCalls(record).length === 0 &&
      hasVisibleText(record),
  );
  if (candidates.length !== 1) return undefined;

  return {
    startExclusiveRecordUuid,
    endInclusiveRecordUuid,
    assistantRecordUuid: candidates[0]!.uuid,
  };
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
  activeChain: readonly ChatRecord[],
): ReadonlyMap<string, BranchPoint> {
  const points = new Map<string, BranchPoint>();
  const recordUuids = new Set<string>();
  for (const record of activeChain) {
    if (
      typeof record.uuid !== 'string' ||
      record.uuid.length === 0 ||
      recordUuids.has(record.uuid)
    ) {
      return points;
    }
    recordUuids.add(record.uuid);
  }
  const checkpointByAssistantUuid = new Map<string, string>();
  const duplicateAssistantUuids = new Set<string>();
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
    const candidate = resolveCompletedTurnBranchCandidate({
      activeChain: activeChain.slice(0, index),
      startExclusiveRecordUuid: payload.startExclusiveRecordUuid,
      endInclusiveRecordUuid: checkpoint.parentUuid,
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
      duplicateAssistantUuids.add(candidate.assistantRecordUuid);
      continue;
    }
    if (duplicateAssistantUuids.has(candidate.assistantRecordUuid)) continue;
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
