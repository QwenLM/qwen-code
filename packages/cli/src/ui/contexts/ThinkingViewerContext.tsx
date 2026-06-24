/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

export interface ThinkingViewerData {
  text: string;
  durationMs?: number;
}

export interface ThinkingViewerContextType {
  openThinkingViewer: (data: ThinkingViewerData) => void;
}

const ThinkingViewerContext = createContext<ThinkingViewerContextType>({
  openThinkingViewer: () => {},
});

export const useThinkingViewer = (): ThinkingViewerContextType =>
  useContext(ThinkingViewerContext);

export const ThinkingViewerProvider = ThinkingViewerContext.Provider;
