/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ChatCompressionRecordPayload,
  ChatRecord,
} from './chatRecordingService.js';
import {
  catalogSnapshotChars,
  estimateContentChars,
  TOKEN_TO_CHAR_RATIO,
} from '../utils/content-token-estimate.js';
import { getUsageOutputTokenCountForPromptEstimate } from './tokenEstimation.js';

export interface ResumeTokenCounts {
  promptTokenCount: number;
  outputTokenCount: number;
  isEstimated: boolean;
  /** The persisted input count adjusts provider usage that already includes system and tools. */
  isProviderAdjusted?: boolean;
  /** Apply a positive delta when enabling memory catalogs, a negative one when disabling them. */
  catalogSwitchTokens?: number;
}

function assistantPromptTokenCount(record: ChatRecord): number | undefined {
  const usage = record.usageMetadata;
  return (
    record.resumePromptTokenCount ??
    ((usage?.promptTokenCount ?? usage?.totalTokenCount) || undefined)
  );
}

// Previous checkpoints with per-entry sizes can identify a locally charged
// snapshot even though they did not explicitly record the catalog adjustment.
function legacyCatalogSwitchChars(
  payload: ChatCompressionRecordPayload,
  index: number,
  saved: number,
): number {
  const entry = payload.compressedHistory[index];
  if (!entry) return 0;
  const catalog = catalogSnapshotChars(entry);
  if (!catalog) return 0;
  const imageCost = payload.info.historyImageTokenEstimate;
  const visible = estimateContentChars(entry, imageCost ?? 0);
  const hidden = visible - catalog;
  // Old writers rounded pending input separately. When its charge alone
  // explains the saved override, use the same rounding for its alternative.
  const pricedPending =
    index === payload.compressedHistory.length - 1 &&
    entry.role === 'user' &&
    payload.resumePromptTokenCount !== undefined &&
    payload.resumePromptTokenCount - payload.info.newTokenCount ===
      saved / TOKEN_TO_CHAR_RATIO;
  if (pricedPending) {
    // The old checkpoint did not record the pending image price.
    if (estimateContentChars(entry, 1) !== estimateContentChars(entry, 0))
      return 0;
    const withCatalog =
      Math.ceil(visible / TOKEN_TO_CHAR_RATIO) * TOKEN_TO_CHAR_RATIO;
    const withoutCatalog =
      Math.ceil(hidden / TOKEN_TO_CHAR_RATIO) * TOKEN_TO_CHAR_RATIO;
    if (saved === withCatalog) return withoutCatalog - withCatalog;
    return saved === withoutCatalog ? withCatalog - withoutCatalog : 0;
  }
  if (imageCost === undefined) return 0;
  if (saved === visible) return -catalog;
  return saved === hidden ? catalog : 0;
}

function catalogSwitchTokens(payload: ChatCompressionRecordPayload): number {
  const sizes = payload.pruneContentChars;
  if (
    !Array.isArray(sizes) ||
    sizes.length !== payload.compressedHistory?.length
  )
    return 0;
  let saved = 0;
  let alternate = 0;
  for (const [index, chars] of sizes.entries()) {
    const change =
      payload.catalogSwitchChars?.[index] ??
      legacyCatalogSwitchChars(payload, index, chars);
    if (
      !Number.isFinite(chars) ||
      !Number.isFinite(change) ||
      chars < 0 ||
      chars + change < 0
    )
      return 0;
    saved += chars;
    alternate += chars + change;
  }
  return (
    Math.ceil(alternate / TOKEN_TO_CHAR_RATIO) -
    Math.ceil(saved / TOKEN_TO_CHAR_RATIO)
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
        const delta = catalogSwitchTokens(payload);
        this.value = {
          ...(delta && { catalogSwitchTokens: delta }),
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
  return Boolean(payload?.info);
}

export function getResumeTokenCounts(conversation: {
  messages: readonly ChatRecord[];
}): ResumeTokenCounts | undefined {
  const accumulator = new ResumeTokenCountsAccumulator();
  const latest = conversation.messages.findLast(isResumeTokenCountsCandidate);
  if (latest) accumulator.add(latest);
  return accumulator.finish();
}

export function getResumePromptTokenCount(conversation: {
  messages: readonly ChatRecord[];
}): number | undefined {
  return getResumeTokenCounts(conversation)?.promptTokenCount;
}
