/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { ThoughtSummary } from '@qwen-code/core';
import type { HistoryItemWithoutId } from '../types.js';

/**
 * Per-delta streaming state, deliberately kept out of `UIState`.
 *
 * Both arrays are rebuilt on every assistant delta and `thought` is re-parsed
 * on every thinking delta. While they lived in the giant `uiState` memo they
 * changed its identity on every delta, so all ~50 `useUIState()` consumers
 * re-rendered even though only a handful read them.
 */
export interface PendingHistoryValue {
  pendingHistoryItems: HistoryItemWithoutId[];
  pendingGeminiHistoryItems: HistoryItemWithoutId[];
  /** Current model thought while streaming; null outside thinking phases. */
  thought: ThoughtSummary | null;
}

const EMPTY_PENDING: PendingHistoryValue = {
  pendingHistoryItems: [],
  pendingGeminiHistoryItems: [],
  thought: null,
};

export const PendingHistoryContext =
  createContext<PendingHistoryValue>(EMPTY_PENDING);

export const usePendingHistory = (): PendingHistoryValue =>
  useContext(PendingHistoryContext);
