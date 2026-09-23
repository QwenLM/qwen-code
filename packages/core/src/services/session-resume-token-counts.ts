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
}

export class ResumeTokenCountsAccumulator {
  private value: ResumeTokenCounts | undefined;

  add(record: ChatRecord): void {
    if (record.type === 'assistant') {
      const usage = record.usageMetadata;
      const candidate = usage?.promptTokenCount ?? usage?.totalTokenCount;
      if (candidate) {
        this.value = {
          promptTokenCount: candidate,
          outputTokenCount: getUsageOutputTokenCountForPromptEstimate(usage),
          isEstimated: false,
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
          promptTokenCount: payload.info.newTokenCount,
          outputTokenCount: 0,
          isEstimated: payload.info.newTokenCountIsEstimated ?? true,
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
    const usage = record.usageMetadata;
    return Boolean(usage?.promptTokenCount ?? usage?.totalTokenCount);
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
