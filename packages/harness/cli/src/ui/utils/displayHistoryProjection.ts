/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { checkExhaustive } from '@qwen-code/core';
import type { HistoryItemWithoutId } from '../types.js';

export type DisplayHistoryChange =
  | { type: 'snapshot'; items: HistoryItemWithoutId[] }
  | { type: 'append'; item: HistoryItemWithoutId }
  | { type: 'pending'; items: HistoryItemWithoutId[] };

export interface DisplayHistoryTarget {
  isHistoryAvailable: () => boolean;
  markHistoryAvailable: () => void;
  addHistoryItem: (item: HistoryItemWithoutId) => void;
  setPendingHistory: (items: HistoryItemWithoutId[] | null) => void;
}

export function prepareMessageHistory(
  {
    historyAvailable,
    preferDisplayEvents,
    allowDurableDisplayFallback,
  }: {
    historyAvailable: boolean;
    preferDisplayEvents?: boolean;
    allowDurableDisplayFallback?: boolean;
  },
  setPendingHistory: DisplayHistoryTarget['setPendingHistory'],
): boolean {
  const suppress =
    (historyAvailable || preferDisplayEvents === true) &&
    !allowDurableDisplayFallback;
  if (allowDurableDisplayFallback) {
    setPendingHistory(null);
  }
  return suppress;
}

export function applyDisplayHistoryChange(
  change: DisplayHistoryChange,
  target: DisplayHistoryTarget,
): void {
  switch (change.type) {
    case 'snapshot':
      if (!target.isHistoryAvailable()) {
        for (const item of change.items) target.addHistoryItem(item);
      }
      target.markHistoryAvailable();
      break;
    case 'append':
      target.markHistoryAvailable();
      target.addHistoryItem(change.item);
      break;
    case 'pending':
      target.markHistoryAvailable();
      target.setPendingHistory(
        change.items.map(
          (item) => JSON.parse(JSON.stringify(item)) as HistoryItemWithoutId,
        ),
      );
      break;
    default:
      checkExhaustive(change);
  }
}
