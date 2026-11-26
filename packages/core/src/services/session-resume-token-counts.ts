/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import type {
  ChatCompressionRecordPayload,
  ChatRecord,
} from './chatRecordingService.js';
import {
  catalogSnapshotChars,
  estimateContentChars,
  savedMediaTokenCosts,
  TOKEN_TO_CHAR_RATIO,
} from '../utils/content-token-estimate.js';
import { AUTO_MEMORY_SNAPSHOT_METADATA } from '../utils/api-history-metadata.js';
import { isUserPromptSubmitContextPartText } from '../utils/transcript-records.js';
import { getUsageOutputTokenCountForPromptEstimate } from './tokenEstimation.js';

export interface PricedCatalogEntry {
  snapshots: string[];
  change: number;
}

export interface ResumeHistoryBoundary {
  restoredHistory?: Content[];
  mediaTokenCosts?: number[][];
  trailingEntries: number;
  partCount?: number;
  endsWithHookContext?: boolean;
}

export interface ResumeTokenCounts {
  promptTokenCount: number;
  outputTokenCount: number;
  isEstimated: boolean;
  /** The persisted input count adjusts provider usage that already includes system and tools. */
  isProviderAdjusted?: boolean;
  /** Local image estimate shared by all entries in the restored token baseline. */
  historyImageTokenEstimate?: number;
  /** Saved history can be followed by new entries or a continuation of its last user turn. */
  historyCheckpoint?: {
    entries: number;
    mediaTokenCosts?: number[][];
    lastEntryParts?: number;
    endsWithHookContext?: boolean;
  };
  /** Apply a positive delta when enabling memory catalogs, a negative one when disabling them. */
  catalogSwitchTokens?: number;
  /** Saved per-entry adjustments when only part of the history was priced locally. */
  pricedCatalogEntries?: PricedCatalogEntry[];
}

export function captureResumeHistoryBoundary(
  history: Content[],
  checkpoint: ResumeTokenCounts['historyCheckpoint'],
): ResumeHistoryBoundary | undefined {
  if (!checkpoint || checkpoint.entries > history.length) return undefined;
  // Startup can insert tool results, move existing parts and remove duplicate
  // entries. Snapshot the replayed containers before those repairs. Keep leaf
  // payloads shared so their stored per-image prices still identify them.
  return {
    restoredHistory: history.map((entry) => ({
      ...entry,
      ...(entry.parts && { parts: [...entry.parts] }),
    })),
    trailingEntries: history.length - checkpoint.entries,
    partCount: checkpoint.lastEntryParts,
    ...(checkpoint.mediaTokenCosts && {
      mediaTokenCosts: checkpoint.mediaTokenCosts,
    }),
    ...(checkpoint.endsWithHookContext && { endsWithHookContext: true }),
  };
}

function assistantPromptTokenCount(record: ChatRecord): number | undefined {
  const usage = record.usageMetadata;
  return (
    record.resumePromptTokenCount ??
    ((usage?.promptTokenCount ?? usage?.totalTokenCount) || undefined)
  );
}

function savedHistoryImageTokenEstimate(
  payload: ChatCompressionRecordPayload,
): number | undefined {
  // Earlier fast checkpoints had no pending input and no summary prefix in
  // info. Full compression also stamped an inherited tail with the local price.
  const price =
    payload.historyImageTokenEstimate ??
    (payload.info.triggerReason === 'manual' &&
    payload.info.summaryPrefixLength === undefined
      ? payload.info.historyImageTokenEstimate
      : undefined);
  return price !== undefined && Number.isFinite(price) && price >= 1
    ? price
    : undefined;
}

// Previous checkpoints with per-entry sizes can identify a locally charged
// snapshot even though they did not explicitly record the catalog adjustment.
function legacyCatalogSwitchChars(
  payload: ChatCompressionRecordPayload,
  index: number,
  saved: number,
  imageCost: number | undefined,
): number {
  const entry = payload.compressedHistory[index];
  if (!entry) return 0;
  const catalog = catalogSnapshotChars(entry);
  if (!catalog) return 0;
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

function resumeCatalogPricing(
  payload: ChatCompressionRecordPayload,
  imageCost: number | undefined,
): Pick<ResumeTokenCounts, 'catalogSwitchTokens' | 'pricedCatalogEntries'> {
  const sizes = payload.pruneContentChars;
  if (
    !Array.isArray(sizes) ||
    sizes.length !== payload.compressedHistory?.length
  )
    return {};
  const entries: PricedCatalogEntry[] = [];
  let saved = 0;
  let alternate = 0;
  for (const [index, chars] of sizes.entries()) {
    const change =
      payload.catalogSwitchChars?.[index] ??
      legacyCatalogSwitchChars(payload, index, chars, imageCost);
    if (
      !Number.isFinite(chars) ||
      !Number.isFinite(change) ||
      chars < 0 ||
      chars + change < 0
    )
      return {};
    if (imageCost === undefined) {
      const snapshots = payload.compressedHistory[index]?.parts?.flatMap(
        (part) =>
          part.partMetadata?.[AUTO_MEMORY_SNAPSHOT_METADATA] === true &&
          typeof part.text === 'string'
            ? [part.text]
            : [],
      );
      if (snapshots?.length) entries.push({ snapshots, change });
    }
    saved += chars;
    alternate += chars + change;
  }
  const delta =
    Math.ceil(alternate / TOKEN_TO_CHAR_RATIO) -
    Math.ceil(saved / TOKEN_TO_CHAR_RATIO);
  return {
    ...(delta && { catalogSwitchTokens: delta }),
    ...(entries.some((entry) => entry.change !== 0) && {
      pricedCatalogEntries: entries,
    }),
  };
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
        const historyImageTokenEstimate =
          savedHistoryImageTokenEstimate(payload);
        const history = payload.compressedHistory;
        const last = Array.isArray(history) ? history.at(-1) : undefined;
        const mediaTokenCosts =
          historyImageTokenEstimate === undefined
            ? savedMediaTokenCosts(payload)
            : undefined;
        this.value = {
          ...(historyImageTokenEstimate !== undefined && {
            historyImageTokenEstimate,
          }),
          ...((historyImageTokenEstimate !== undefined || mediaTokenCosts) &&
            Array.isArray(history) && {
              historyCheckpoint: {
                entries: history.length,
                ...(mediaTokenCosts && { mediaTokenCosts }),
                ...(history.length && {
                  lastEntryParts: last?.parts?.length ?? 0,
                  ...(last?.role === 'user' &&
                    isUserPromptSubmitContextPartText(
                      last.parts?.at(-1)?.text ?? '',
                    ) && { endsWithHookContext: true }),
                }),
              },
            }),
          ...resumeCatalogPricing(payload, historyImageTokenEstimate),
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
