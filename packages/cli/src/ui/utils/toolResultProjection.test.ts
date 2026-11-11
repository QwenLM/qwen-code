/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CoreToolCallStatus, type HistoryItemWithoutId } from '../types.js';
import { appendToolResultsToHistory } from './toolResultProjection.js';

describe('appendToolResultsToHistory', () => {
  it('groups results in order and retains success versus error status', () => {
    const history: HistoryItemWithoutId[] = [];
    appendToolResultsToHistory(
      [
        {
          toolUse: {
            id: 'first',
            name: 'mcp__demo__lookup',
            input: { query: 'a' },
          },
          toolResult: { content: 'ok', isError: false },
        },
        {
          toolUse: {
            id: 'second',
            name: 'mcp__demo__lookup',
            input: { query: 'b' },
          },
          toolResult: { content: 'failed', isError: true },
        },
      ],
      (item) => history.push(item),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      type: 'tool_group',
      tools: [
        { callId: 'first', status: CoreToolCallStatus.Success },
        { callId: 'second', status: CoreToolCallStatus.Error },
      ],
    });
  });

  it('uses structured tool results and does not mutate source data', () => {
    const result = {
      toolUse: { id: 'call-1', name: 'mcp__demo__lookup', input: {} },
      toolResult: {
        content: 'model-only content',
        isError: false,
        toolUseResult: 'display result',
      },
    };
    Object.freeze(result.toolUse);
    Object.freeze(result.toolResult);
    Object.freeze(result);
    const history: HistoryItemWithoutId[] = [];
    appendToolResultsToHistory([result], (item) => history.push(item));
    expect(history[0]).toMatchObject({
      type: 'tool_group',
      tools: [{ callId: 'call-1', resultDisplay: 'display result' }],
    });
    expect(result.toolResult.content).toBe('model-only content');
  });
});
