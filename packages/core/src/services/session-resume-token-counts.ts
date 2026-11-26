/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatCompressionRecordPayload,
  ChatRecord,
} from './chatRecordingService.js';
import { getUsageOutputTokenCountForPromptEstimate } from './tokenEstimation.js';

export interface ResumeTokenCounts {
  promptTokenCount: number;
  outputTokenCount: number;
  isEstimated: boolean;
  /** The persisted input count adjusts provider usage that already includes system and tools. */
  isProviderAdjusted?: boolean;
}

function assistantPromptTokenCount(record: ChatRecord): number | undefined {
  const usage = record.usageMetadata;
  return (
    record.resumePromptTokenCount ??
    ((usage?.promptTokenCount ?? usage?.totalTokenCount) || undefined)
  );
}

export class ResumeTokenCountsAccumulator {
  private value: ResumeTokenCounts | undefined;

  add(record: ChatRecord): void {
    if (record.type === 'assistant') {
      const usage = record.usageMetadata;
      const promptTokenCount = assistantPromptTokenCount(record);
      if (promptTokenCount !== undefined) {
        this.value = {
          promptTokenCount,
          outputTokenCount: usage?.promptTokenCount
            ? getUsageOutputTokenCountForPromptEstimate(usage)
            : 0,
          isEstimated: record.resumePromptTokenCount !== undefined,
          ...(record.resumePromptTokenCount !== undefined &&
            (usage?.promptTokenCount || usage?.totalTokenCount) && {
              isProviderAdjusted: true,
            }),
        };
      }
      return;
    }

    if (record.type === 'system' && record.subtype === 'chat_compression') {
      const payload = record.systemPayload as
        | ChatCompressionRecordPayload
        | undefined;
      if (payload?.info) {
        this.value = {
          promptTokenCount:
            payload.resumePromptTokenCount ?? payload.info.newTokenCount,
          outputTokenCount: 0,
          isEstimated:
            payload.resumePromptTokenCount !== undefined ||
            (payload.info.newTokenCountIsEstimated ?? true),
        };
      }
    }
  }

  finish(): ResumeTokenCounts | undefined {
    return this.value;
  }
}

export function isResumeTokenCountsCandidate(record: ChatRecord): boolean {
  if (record.type === 'assistant') {
    return assistantPromptTokenCount(record) !== undefined;
  }
  if (record.type !== 'system' || record.subtype !== 'chat_compression') {
    return false;
  }
  const payload = record.systemPayload as
    | ChatCompressionRecordPayload
    | undefined;
  return payload?.info !== undefined;
}

export function getResumeTokenCounts(conversation: {
  messages: readonly ChatRecord[];
}): ResumeTokenCounts | undefined {
  const accumulator = new ResumeTokenCountsAccumulator();
  for (const record of conversation.messages) accumulator.add(record);
  return accumulator.finish();
}

export function getResumePromptTokenCount(conversation: {
  messages: readonly ChatRecord[];
}): number | undefined {
  return getResumeTokenCounts(conversation)?.promptTokenCount;
}
