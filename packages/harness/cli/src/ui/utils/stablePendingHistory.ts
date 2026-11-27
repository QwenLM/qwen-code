/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryItemWithoutId } from '../types.js';

export interface StablePendingHistoryItem {
  item: HistoryItemWithoutId;
  key: string;
  id: number;
}

export interface StablePendingHistoryState {
  scope: number;
  nextId: number;
  items: readonly StablePendingHistoryItem[];
}

export function createStablePendingHistoryState(
  scope: number,
): StablePendingHistoryState {
  return { scope, nextId: 1, items: [] };
}

type MatchCandidate = {
  currentIndex: number;
  previousIndex: number;
  score: number;
};

/**
 * Reconciles live history by semantic identity instead of array position. Items
 * that move because a sibling was inserted or committed retain their key and
 * synthetic numeric id.
 */
export function reconcileStablePendingHistory(
  previousState: StablePendingHistoryState,
  currentItems: readonly HistoryItemWithoutId[],
  scope: number,
): StablePendingHistoryState {
  const previousItems =
    previousState.scope === scope ? previousState.items : [];
  let nextId = previousState.scope === scope ? previousState.nextId : 1;
  const candidates: MatchCandidate[] = [];

  for (let currentIndex = 0; currentIndex < currentItems.length; currentIndex++) {
    for (
      let previousIndex = 0;
      previousIndex < previousItems.length;
      previousIndex++
    ) {
      const score = pendingItemMatchScore(
        previousItems[previousIndex].item,
        currentItems[currentIndex],
      );
      if (score > 0) {
        candidates.push({ currentIndex, previousIndex, score });
      }
    }
  }

  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      Math.abs(left.currentIndex - left.previousIndex) -
        Math.abs(right.currentIndex - right.previousIndex) ||
      left.currentIndex - right.currentIndex ||
      left.previousIndex - right.previousIndex,
  );

  const matchedCurrent = new Map<number, StablePendingHistoryItem>();
  const usedPrevious = new Set<number>();
  for (const candidate of candidates) {
    if (
      matchedCurrent.has(candidate.currentIndex) ||
      usedPrevious.has(candidate.previousIndex)
    ) {
      continue;
    }
    matchedCurrent.set(
      candidate.currentIndex,
      previousItems[candidate.previousIndex],
    );
    usedPrevious.add(candidate.previousIndex);
  }

  const items = currentItems.map((item, index): StablePendingHistoryItem => {
    const previous = matchedCurrent.get(index);
    if (previous) {
      return { ...previous, item };
    }

    const id = nextId++;
    return {
      item,
      id: -id,
      key: `pending:${scope}:${id}`,
    };
  });

  return { scope, nextId, items };
}

function pendingItemMatchScore(
  previous: HistoryItemWithoutId,
  current: HistoryItemWithoutId,
): number {
  if (previous === current) return 1000;
  if (previous.type !== current.type) return 0;

  if (
    previous.toolCallId &&
    current.toolCallId &&
    previous.toolCallId === current.toolCallId
  ) {
    return 950;
  }

  if (previous.type === 'tool_group' && current.type === 'tool_group') {
    const previousIds = new Set(previous.tools.map((tool) => tool.callId));
    const currentIds = current.tools.map((tool) => tool.callId);
    if (
      previousIds.size > 0 &&
      currentIds.length > 0 &&
      currentIds.every((id) => previousIds.has(id)) &&
      previousIds.size === currentIds.length
    ) {
      return 950;
    }
    if (currentIds.some((id) => previousIds.has(id))) return 900;
    if (
      previous.tools.length === 0 &&
      current.tools.length === 0 &&
      previous.borderTop === current.borderTop &&
      previous.borderBottom === current.borderBottom
    ) {
      return 700;
    }
    return 0;
  }

  if (previous.type === 'model_queue' && current.type === 'model_queue') {
    const previousKey =
      previous.modelQueue.requestId ?? previous.modelQueue.requestSetId;
    const currentKey = current.modelQueue.requestId ?? current.modelQueue.requestSetId;
    if (previousKey && currentKey) return previousKey === currentKey ? 950 : 0;
    return previous.modelQueue.modelKey === current.modelQueue.modelKey &&
      previous.modelQueue.queueType === current.modelQueue.queueType
      ? 700
      : 0;
  }

  if (previous.type === 'subagent' && current.type === 'subagent') {
    if (previous.parentToolUseId || current.parentToolUseId) {
      return previous.parentToolUseId === current.parentToolUseId &&
        previous.agentName === current.agentName
        ? 950
        : 0;
    }
    return previous.agentName === current.agentName ? 650 : 0;
  }

  if (previous.type === 'thinking' && current.type === 'thinking') {
    const progressiveScore = progressiveTextScore(
      `${previous.thought.subject}\n${previous.thought.description}`,
      `${current.thought.subject}\n${current.thought.description}`,
    );
    // parseThought can move text from description to subject as soon as a
    // closing delimiter arrives, even though it is still the same live block.
    return progressiveScore || 600;
  }

  if (previous.type === 'help' && current.type === 'help') {
    return previous.timestamp.getTime() === current.timestamp.getTime() ? 900 : 0;
  }

  const previousText = previous.text;
  const currentText = current.text;
  if (typeof previousText === 'string' && typeof currentText === 'string') {
    return progressiveTextScore(previousText, currentText);
  }

  return 0;
}

function progressiveTextScore(previous: string, current: string): number {
  if (previous === current) return 850;
  if (current.length > previous.length && current.startsWith(previous)) {
    return 800;
  }
  return 0;
}
