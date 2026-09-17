/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Navigation-turn derivation shared by the in-memory transcript index
// (session-transcript-reader.ts) and the SQLite sidecar indexer
// (session-index/sqlite.ts). Both paths must derive identical turn
// boundaries and assistant-preview candidates from the same record, so the
// logic lives in this dependency-free module instead of being duplicated.

import {
  isUserPromptSubmitContextPartText,
  projectUserTranscriptForDisplay,
  stripGeneratedAttachmentTokens,
} from '../../utils/transcript-records.js';
import type { ChatRecord } from '../chatRecordingService.js';

export type SessionTranscriptNavigationTurnKind =
  | 'prompt'
  | 'realtime'
  | 'scheduled';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function navigationDisplayText(
  text: string,
  systemPayload: unknown,
): string {
  const stripped = stripGeneratedAttachmentTokens(text, systemPayload);
  return isUserPromptSubmitContextPartText(stripped) ? '' : stripped;
}

export function navigationKindForRecord(
  record: ChatRecord,
): SessionTranscriptNavigationTurnKind | undefined {
  if (record.type !== 'user') return undefined;
  if (
    record.subtype === 'goal_runtime' ||
    record.subtype === 'notification' ||
    record.subtype === 'mid_turn_user_message'
  ) {
    return undefined;
  }
  if (record.subtype === 'cron') {
    const payload = isObjectRecord(record.systemPayload)
      ? record.systemPayload
      : undefined;
    const displayText =
      typeof payload?.['displayText'] === 'string'
        ? navigationDisplayText(payload['displayText'], record.systemPayload)
        : '';
    return displayText.trim().length > 0 ? 'scheduled' : undefined;
  }

  const projection = projectUserTranscriptForDisplay(record);
  const displayText =
    projection.displayText === undefined
      ? undefined
      : navigationDisplayText(projection.displayText, record.systemPayload);
  const hasVisibleText =
    displayText !== undefined
      ? displayText.trim().length > 0
      : projection.parts.some(
          (part) =>
            isObjectRecord(part) &&
            typeof part['text'] === 'string' &&
            part['text'].trim().length > 0 &&
            !isUserPromptSubmitContextPartText(part['text']),
        );
  const hasVisibleAttachment =
    projection.parts.some((part) => {
      if (!isObjectRecord(part) || !isObjectRecord(part['inlineData'])) {
        return false;
      }
      const inlineData = part['inlineData'];
      return (
        typeof inlineData['data'] === 'string' &&
        typeof inlineData['mimeType'] === 'string' &&
        inlineData['mimeType'].startsWith('image/')
      );
    }) ||
    (isObjectRecord(record.systemPayload) &&
      Array.isArray(record.systemPayload['attachmentReferences']) &&
      record.systemPayload['attachmentReferences'].some(
        (reference) =>
          isObjectRecord(reference) &&
          (reference['type'] === 'image' || reference['type'] === 'resource') &&
          typeof reference['attachmentId'] === 'string' &&
          typeof reference['mimeType'] === 'string' &&
          typeof reference['size'] === 'number',
      ));
  if (!hasVisibleText && !hasVisibleAttachment) return undefined;
  return record.subtype === 'realtime_message' ? 'realtime' : 'prompt';
}

export function isAssistantPreviewCandidate(record: ChatRecord): boolean {
  return (
    record.type === 'assistant' &&
    (record.message?.parts ?? []).some(
      (part) =>
        isObjectRecord(part) &&
        part['thought'] !== true &&
        typeof part['text'] === 'string' &&
        part['text'].trim().length > 0,
    )
  );
}
