/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from './chatRecordingService.js';

export interface SessionTurnState {
  initialTurn: number;
  turnParentUuids: Array<string | null>;
  backgroundNotificationTaskIds: string[];
}

export interface SessionTurnRecordHint {
  promptTurn?: number;
  countsAsUserPrompt: boolean;
  turnParentUuid?: string | null;
  backgroundNotificationTaskId?: string;
}

export class SessionTurnStateAccumulator {
  private maxPromptTurn = 0;
  private userMessageCount = 0;
  private readonly turnParentUuids: Array<string | null> = [];
  private readonly backgroundNotificationTaskIds = new Set<string>();

  constructor(private readonly sessionId: string) {}

  add(record: ChatRecord): void {
    this.addHint(getSessionTurnRecordHint(record, this.sessionId));
  }

  addHint(hint: SessionTurnRecordHint): void {
    if (hint.countsAsUserPrompt) {
      this.userMessageCount += 1;
    }
    if (hint.promptTurn !== undefined) {
      this.maxPromptTurn = Math.max(this.maxPromptTurn, hint.promptTurn);
    }
    if (hint.turnParentUuid !== undefined) {
      this.turnParentUuids.push(hint.turnParentUuid);
    }
    if (hint.backgroundNotificationTaskId !== undefined) {
      this.backgroundNotificationTaskIds.add(hint.backgroundNotificationTaskId);
    }
  }

  finish(): SessionTurnState {
    return {
      initialTurn:
        this.maxPromptTurn > 0 ? this.maxPromptTurn : this.userMessageCount,
      turnParentUuids: [...this.turnParentUuids],
      backgroundNotificationTaskIds: [...this.backgroundNotificationTaskIds],
    };
  }
}

export function getSessionTurnRecordHint(
  record: ChatRecord,
  sessionId: string,
): SessionTurnRecordHint {
  let promptTurn: number | undefined;
  for (const promptId of getRecordPromptIds(record)) {
    const candidate = parseSessionPromptTurn(promptId, sessionId);
    if (candidate !== undefined) {
      promptTurn = Math.max(promptTurn ?? 0, candidate);
    }
  }
  const turnParentUuid =
    record.type === 'user' &&
    record.subtype !== 'goal_runtime' &&
    record.subtype !== 'notification' &&
    record.subtype !== 'cron' &&
    record.subtype !== 'mid_turn_user_message' &&
    record.subtype !== 'realtime_message'
      ? (record.parentUuid ?? null)
      : undefined;
  const backgroundTask =
    record.subtype === 'notification'
      ? (
          record.systemPayload as
            | { backgroundTask?: { taskId?: unknown } }
            | undefined
        )?.backgroundTask
      : undefined;
  return {
    ...(promptTurn !== undefined ? { promptTurn } : {}),
    countsAsUserPrompt:
      record.sessionId === sessionId && isUserPromptRecord(record),
    ...(turnParentUuid !== undefined ? { turnParentUuid } : {}),
    ...(typeof backgroundTask?.taskId === 'string'
      ? { backgroundNotificationTaskId: backgroundTask.taskId }
      : {}),
  };
}

export function collectSessionTurnState(
  records: readonly ChatRecord[],
  sessionId: string,
): SessionTurnState {
  const accumulator = new SessionTurnStateAccumulator(sessionId);
  for (const record of records) accumulator.add(record);
  return accumulator.finish();
}

export function computeInitialTurnFromHistory(
  records: readonly ChatRecord[],
  sessionId: string,
): number {
  return collectSessionTurnState(records, sessionId).initialTurn;
}

function getRecordPromptIds(record: ChatRecord): string[] {
  const promptIds: string[] = [];
  const recordPromptId = (record as { promptId?: unknown }).promptId;
  if (typeof recordPromptId === 'string') promptIds.push(recordPromptId);
  const telemetryPromptId = readTelemetryPromptId(record.systemPayload);
  if (telemetryPromptId) promptIds.push(telemetryPromptId);
  return promptIds;
}

function readTelemetryPromptId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || !('uiEvent' in payload)) {
    return undefined;
  }
  const uiEvent = (payload as { uiEvent?: unknown }).uiEvent;
  if (!uiEvent || typeof uiEvent !== 'object' || !('prompt_id' in uiEvent)) {
    return undefined;
  }
  const promptId = (uiEvent as { prompt_id?: unknown }).prompt_id;
  return typeof promptId === 'string' ? promptId : undefined;
}

function parseSessionPromptTurn(
  promptId: string,
  sessionId: string,
): number | undefined {
  const promptIdPrefix = `${sessionId}########`;
  if (!promptId.startsWith(promptIdPrefix)) return undefined;
  const suffix = promptId.slice(promptIdPrefix.length);
  return /^\d+$/.test(suffix) ? Number(suffix) : undefined;
}

function isUserPromptRecord(record: ChatRecord): boolean {
  if (record.type !== 'user' || record.subtype === 'realtime_message') {
    return false;
  }
  return (
    record.message?.parts?.some(
      (part) => typeof part.text === 'string' && part.text.trim().length > 0,
    ) ?? false
  );
}
