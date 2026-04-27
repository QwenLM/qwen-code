/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

interface CompactModeContextType {
  compactMode: boolean;
  setCompactMode?: (value: boolean) => void;
}

const CompactModeContext = createContext<CompactModeContextType>({
  compactMode: false,
});

export const useCompactMode = (): CompactModeContextType =>
  useContext(CompactModeContext);

export const CompactModeProvider = CompactModeContext.Provider;
