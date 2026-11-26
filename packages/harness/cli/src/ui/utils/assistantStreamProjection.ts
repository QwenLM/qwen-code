/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { parseThought, type ThoughtSummary } from '@qwen-code/core';
import type { AssistantStreamDelta } from '../../session/sessionPort.js';
import type { HistoryItemWithoutId } from '../types.js';
import type { ThinkingTextState } from '../state/thinkingTextState.js';

export function applyAssistantStreamDelta(
  delta: AssistantStreamDelta,
  {
    thinkingTextState,
    appendAssistantText,
    setThought,
    addHistoryItem,
  }: {
    thinkingTextState: ThinkingTextState;
    appendAssistantText: (text: string) => void;
    setThought: (thought: ThoughtSummary | null) => void;
    addHistoryItem: (item: HistoryItemWithoutId) => void;
  },
): void {
  if (delta.type === 'text_delta') {
    flushAccumulatedThinkingToHistory(addHistoryItem, thinkingTextState);
    appendAssistantText(delta.text);
    setThought(null);
    return;
  }

  if (delta.type === 'thinking_delta') {
    const thinkingText = thinkingTextState.append(delta.text);
    const parsed = parseThought(thinkingText);
    if (parsed) {
      setThought(parsed);
    }
  }
}

function flushAccumulatedThinkingToHistory(
  addHistoryItem: (item: HistoryItemWithoutId) => void,
  thinkingTextState: ThinkingTextState,
): void {
  const thinkingText = thinkingTextState.takePending();
  if (!thinkingText.trim()) {
    return;
  }
  if (!thinkingTextState.markPersisted(thinkingText)) {
    return;
  }
  addHistoryItem({
    type: 'thinking',
    thought: parseThought(thinkingText),
  });
}
