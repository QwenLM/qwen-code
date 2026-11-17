/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { getApiHistoryPromptId } from '../utils/api-history-metadata.js';

/** Return a boundary only when the latest response is a complete operation. */
export function findRetainedCompactionTail(
  history: readonly Content[],
  pendingToolResult?: Content,
): number | undefined {
  const start = history.findLastIndex((entry) => entry.role === 'model');
  if (start < 2) return undefined;
  const isRealResponse = (entry: Content) =>
    entry.role === 'model' &&
    entry.parts?.some(
      (part) =>
        !!part.functionCall ||
        (!!part.text &&
          !part.thought &&
          part.text !== 'Got it. Thanks for the additional context!'),
    );
  if (
    !isRealResponse(history[start]) ||
    !history.slice(0, start).some(isRealResponse)
  ) {
    return undefined;
  }

  const calls = (history[start].parts ?? []).flatMap((part) =>
    part.functionCall ? [part.functionCall] : [],
  );
  const remaining = [...calls];
  const results = history.slice(start + 1);
  if (pendingToolResult) results.push(pendingToolResult);
  for (const entry of results) {
    if (entry.role !== 'user') return undefined;
    if (
      getApiHistoryPromptId(entry) === undefined &&
      (!entry.parts?.length ||
        entry.parts.some((part) => !part.functionResponse))
    ) {
      return undefined;
    }
    for (const part of entry.parts ?? []) {
      if (part.functionCall) return undefined;
      const result = part.functionResponse;
      if (!result) continue;
      const matches = remaining.filter((call) =>
        result.id
          ? call.id === result.id && call.name === result.name
          : !call.id && call.name === result.name,
      );
      // Missing IDs are safe only when the name identifies one call.
      if (matches.length !== 1) return undefined;
      remaining.splice(remaining.indexOf(matches[0]), 1);
    }
  }
  return remaining.length === 0 ? start : undefined;
}
