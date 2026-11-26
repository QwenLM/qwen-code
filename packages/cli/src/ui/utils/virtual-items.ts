/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItem, HistoryItemWithoutId } from '../types.js';

// Banner sentinel injected as the first virtual-scroll item so it scrolls with
// content instead of being pinned at the top (saves vertical space on small
// terminals).
export type VpBannerItem = { type: 'vp-banner'; id: number };
export type VpItem = HistoryItem | VpBannerItem;
export const VP_BANNER_ID = Number.MIN_SAFE_INTEGER;
export const VP_BANNER_ITEM: VpBannerItem = {
  type: 'vp-banner',
  id: VP_BANNER_ID,
};

/**
 * Combine completed history + live pending items into the data array the
 * virtualized viewport renders: the banner sentinel first, then committed
 * history, then pending items (which get negative IDs of -(i+1) so renderItem
 * can tell them apart).
 *
 * This builder is the single source of truth for *which row an index
 * addresses*. Transcript search and structure navigation compute indexes from
 * the same array, so any change here moves the viewport and its callers
 * together instead of letting them drift a row apart.
 *
 * Collapse duplicate tool_group rows (#9420): the same in-flight batch
 * renders from both committed history and the live pending list between
 * the onComplete commit and the scheduler clearing its display state.
 * Continuation thought/content items can land between the copies, so
 * match across the whole list — never by adjacency — on the scheduler-
 * minted batchId stamped on both copies of one batch, and only when a
 * live pending counterpart exists (it keeps updating, so it wins).
 * callIds are NOT an identity (ids are re-minted after core-history
 * compaction and providers can reuse wire ids), so unrelated batches
 * whose callIds collide keep rendering. Groups without a batchId
 * (adapters) are never collapsed; restored-history ids are unique per
 * mount, so they can never match a live pending batch either.
 */
export function buildVirtualItems(
  visibleHistory: readonly HistoryItem[],
  pendingHistoryItems: readonly HistoryItemWithoutId[],
): VpItem[] {
  const combined: VpItem[] = [
    VP_BANNER_ITEM,
    ...visibleHistory,
    ...pendingHistoryItems.map((item, i) => ({ ...item, id: -(i + 1) })),
  ];

  const livePendingBatchIds = new Set<string>();
  for (const item of pendingHistoryItems) {
    if (item.type === 'tool_group' && item.batchId !== undefined) {
      livePendingBatchIds.add(item.batchId);
    }
  }
  if (livePendingBatchIds.size === 0) return combined;

  const dropped = new Set<VpItem>();
  const committedByBatchId = new Map<string, VpItem>();
  // Same batch twice within the pending list: keep the latest copy only.
  const keptPendingByBatchId = new Map<string, VpItem>();
  for (const item of combined) {
    if (
      item.type !== 'tool_group' ||
      item.batchId === undefined ||
      !livePendingBatchIds.has(item.batchId)
    ) {
      continue;
    }
    if (item.id > 0) {
      committedByBatchId.set(item.batchId, item);
    } else {
      const kept = keptPendingByBatchId.get(item.batchId);
      if (kept) dropped.add(kept);
      keptPendingByBatchId.set(item.batchId, item);
    }
  }
  for (const item of committedByBatchId.values()) dropped.add(item);
  if (dropped.size === 0) return combined;
  return combined.filter((item) => !dropped.has(item));
}
