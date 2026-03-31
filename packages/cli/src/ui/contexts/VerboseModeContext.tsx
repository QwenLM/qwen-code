/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { HistoryItemWithoutId } from '../types.js';

interface VerboseModeContextType {
  verboseMode: boolean;
  frozenSnapshot: HistoryItemWithoutId[] | null;
}

const VerboseModeContext = createContext<VerboseModeContextType>({
  verboseMode: false,
  frozenSnapshot: null,
});

export const useVerboseMode = (): VerboseModeContextType =>
  useContext(VerboseModeContext);

export const VerboseModeProvider = VerboseModeContext.Provider;
