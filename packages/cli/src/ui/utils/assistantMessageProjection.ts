/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseThought } from '@qwen-code/core';
import { MessageType, type HistoryItemWithoutId } from '../types.js';
import type { ThinkingTextState } from '../state/thinkingTextState.js';

export function appendAssistantMessageToHistory(
  { thinkingTexts, text }: { thinkingTexts: readonly string[]; text: string },
  {
    thinkingTextState,
    addHistoryItem,
  }: {
    thinkingTextState: ThinkingTextState;
    addHistoryItem: (item: HistoryItemWithoutId) => void;
  },
): void {
  for (const thinkingText of thinkingTexts) {
    if (!thinkingText.trim()) {
      continue;
    }
    if (!thinkingTextState.markPersisted(thinkingText)) {
      continue;
    }
    addHistoryItem({
      type: 'thinking',
      thought: parseThought(thinkingText),
    });
  }

  if (text.trim()) {
    addHistoryItem({ type: MessageType.GEMINI, text });
  }
}
