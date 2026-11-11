/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface PendingAssistantTextStore {
  getSnapshot: () => string;
  subscribe: (listener: () => void) => () => void;
  append: (text: string) => void;
  replace: (text: string) => void;
}

export function createPendingAssistantTextStore(
  initialText = '',
): PendingAssistantTextStore {
  let currentText = initialText;
  const listeners = new Set<() => void>();

  const replace = (text: string) => {
    if (text === currentText) return;
    currentText = text;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => currentText,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    append: (text) => replace(currentText + text),
    replace,
  };
}
