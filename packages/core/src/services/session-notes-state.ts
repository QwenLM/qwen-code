/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ChatRecord } from './chatRecordingService.js';
import { ToolNames } from '../tools/tool-names.js';

export const SESSION_CONTEXT_TOOL_NAMES = [
  ToolNames.SESSION_NOTES,
  ToolNames.SESSION_HISTORY,
  ToolNames.GET_CONTEXT_REMAINING,
  ToolNames.NEW_CONTEXT,
] as const;

export interface SessionNotesPayload {
  version: 1;
  windowId: string;
  sourceLeafUuid: string;
  text: string;
}

export interface SessionNotesRevision extends SessionNotesPayload {
  revision: string;
}

export interface SessionNotesState {
  windowId?: string;
  sourceLeafUuid?: string;
  latestUser?: { uuid: string; text: string };
  notes?: SessionNotesRevision;
}

export function isSessionContextPart(part: Part): boolean {
  const name = part.functionCall?.name ?? part.functionResponse?.name;
  return SESSION_CONTEXT_TOOL_NAMES.some((candidate) => candidate === name);
}

export function isSubstantiveSessionRecord(record: ChatRecord): boolean {
  if (record.type === 'system' || record.subtype === 'realtime_message') {
    return false;
  }
  const parts = Array.isArray(record.message?.parts)
    ? record.message.parts
    : [];
  return parts.some(
    (part) =>
      part &&
      typeof part === 'object' &&
      !part.thought &&
      !isSessionContextPart(part),
  );
}

export function parseSessionNotesPayload(
  value: unknown,
): SessionNotesPayload | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const payload = value as Record<string, unknown>;
  if (
    payload['version'] !== 1 ||
    typeof payload['windowId'] !== 'string' ||
    !payload['windowId'] ||
    typeof payload['sourceLeafUuid'] !== 'string' ||
    !payload['sourceLeafUuid'] ||
    typeof payload['text'] !== 'string' ||
    !payload['text'].trim() ||
    Buffer.byteLength(payload['text'], 'utf8') > 16 * 1024
  ) {
    return undefined;
  }
  return {
    version: 1,
    windowId: payload['windowId'],
    sourceLeafUuid: payload['sourceLeafUuid'],
    text: payload['text'],
  };
}

export function applySessionNotesRecord(
  state: SessionNotesState,
  record: ChatRecord,
): void {
  if (record.type === 'system' && record.subtype === 'chat_compression') {
    state.windowId = record.uuid;
  } else if (record.type === 'system' && record.subtype === 'session_notes') {
    const payload = parseSessionNotesPayload(record.systemPayload);
    if (payload) state.notes = { ...payload, revision: record.uuid };
  } else if (isSubstantiveSessionRecord(record)) {
    state.windowId ??= record.uuid;
    state.sourceLeafUuid = record.uuid;
    if (
      record.type === 'user' &&
      (record.provenance === 'real_user' ||
        record.subtype === undefined ||
        record.subtype === 'mid_turn_user_message')
    ) {
      const payload = record.systemPayload as
        | { displayText?: string }
        | undefined;
      state.latestUser = {
        uuid: record.uuid,
        text:
          typeof payload?.displayText === 'string'
            ? payload.displayText
            : (Array.isArray(record.message?.parts) ? record.message.parts : [])
                .filter(
                  (part) => !part?.thought && typeof part?.text === 'string',
                )
                .map((part) => part.text)
                .join('\n'),
      };
    }
  }
}
