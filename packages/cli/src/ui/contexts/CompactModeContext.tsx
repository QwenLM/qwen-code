/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { HistoryItemWithoutId } from '../types.js';

interface CompactModeContextType {
  compactMode: boolean;
  frozenSnapshot: HistoryItemWithoutId[] | null;
  setCompactMode?: (value: boolean) => void;
}

const CompactModeContext = createContext<CompactModeContextType>({
  compactMode: false,
  frozenSnapshot: null,
});

export const useCompactMode = (): CompactModeContextType =>
  useContext(CompactModeContext);

export const CompactModeProvider = CompactModeContext.Provider;
