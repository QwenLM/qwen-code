/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ThinkingTextState {
  append: (text: string) => string;
  takePending: () => string;
  clearPending: () => void;
  reset: () => void;
  markPersisted: (text: string) => boolean;
}

export function createThinkingTextState(): ThinkingTextState {
  let pendingText = '';
  const persistedKeys = new Set<string>();

  return {
    append: (text) => {
      pendingText += text;
      return pendingText;
    },
    takePending: () => {
      const text = pendingText;
      pendingText = '';
      return text;
    },
    clearPending: () => {
      pendingText = '';
    },
    reset: () => {
      pendingText = '';
      persistedKeys.clear();
    },
    markPersisted: (text) => {
      const key = text.trim();
      if (!key || persistedKeys.has(key)) return false;
      persistedKeys.add(key);
      return true;
    },
  };
}
