/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  extractDisplayableUserContent,
  isSyntheticUserPayload,
} from '../utils/userMessageContent.js';
import type {
  SessionApproval,
  SessionState,
  SessionHistoryRecord,
} from '../../session/session.js';
import {
  CoreToolCallStatus,
  MessageType,
  type IndividualToolCallDisplay,
  type HistoryItemWithoutId,
} from '../types.js';
import type { CliSessionDisplayInitialState } from './cliSessionBridge.js';

export function approvalDisplay(
  approval: SessionApproval,
): IndividualToolCallDisplay {
  return {
    callId: approval.callId,
    name: approval.name,
    args: approval.input,
    description: approval.description,
    ...(approval.title ? { displayTitle: approval.title } : {}),
    resultDisplay: undefined,
    status: CoreToolCallStatus.AwaitingApproval,
    confirmationDetails: approval.details,
    correlationId: approval.id,
  };
}
/** Render generic conversation messages or existing stored display records. */
export function historyDisplay(
  records: readonly SessionHistoryRecord[],
): HistoryItemWithoutId[] {
  return records.flatMap((record): HistoryItemWithoutId[] => {
    const message = asRecord(record['message']);
    if (message && record['type'] === 'user') {
      const content = message['content'];
      if (
        record['isMeta'] === true ||
        isSyntheticUserPayload(record) ||
        (Array.isArray(content) &&
          content.some((block) => asRecord(block)?.['type'] === 'tool_result'))
      )
        return [];
      const display = extractDisplayableUserContent(content);
      return display.text || display.images.length
        ? [
            {
              type: MessageType.USER,
              text: display.text,
              ...(display.images.length ? { images: display.images } : {}),
            },
          ]
        : [];
    }
    if (message && record['type'] === 'assistant') {
      const text = extractText(message['content']);
      return text.trim() ? [{ type: MessageType.GEMINI, text }] : [];
    }
    const notice = asString(record['content']);
    if (record['type'] === 'system' && notice !== undefined) {
      return [
        {
          type:
            record['level'] === 'error' ? MessageType.ERROR : MessageType.INFO,
          text: notice,
        },
      ];
    }
    return [record as unknown as HistoryItemWithoutId];
  });
}
export function getSessionDisplayState(
  state?: SessionState,
  kind: 'local' | 'external' = 'external',
): CliSessionDisplayInitialState {
  return {
    pendingAssistantText: state?.initialMessages.pendingAssistantText ?? '',
    workerStatus: state?.initialMessages.activityStatus ?? 'idle',
    // The native permission queue renders local requests outside pending history.
    pendingApprovalTools:
      kind === 'local' ? [] : (state?.approvals.map(approvalDisplay) ?? []),
    pendingDisplayHistory: state?.pendingHistory
      ? historyDisplay(state.pendingHistory)
      : null,
    historyAvailable: state?.historyAvailable === true,
  };
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content)
    ? content
        .map((block) => {
          const value = asRecord(block);
          return value?.['type'] === 'text'
            ? (asString(value['text']) ?? '')
            : '';
        })
        .join('')
    : '';
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
