/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import type { PromptStashState } from '../hooks/usePromptStash.js';

export interface InputState {
  buffer: TextBuffer;
  userMessages: string[];
  shellModeActive: boolean;
  showEscapePrompt: boolean;
  inputWidth: number;
  suggestionsWidth: number;
  stash: PromptStashState;
}

export const InputContext = createContext<InputState | null>(null);

export const useInputState = () => {
  const context = useContext(InputContext);
  if (!context) {
    throw new Error('useInputState must be used within an InputProvider');
  }
  return context;
};
