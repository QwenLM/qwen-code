/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { reorderHistoryItems } from './reorderHistoryItems.js';
import type { HistoryItem, IndividualToolCallDisplay } from '../types.js';
import { CoreToolCallStatus, Kind } from '@qwen-code/core';

function makeToolCall(callId: string): IndividualToolCallDisplay {
  return {
    callId,
    name: 'Read',
    description: 'Read a file',
    resultDisplay: 'file contents',
    status: CoreToolCallStatus.Success,
    kind: Kind.Read,
    confirmationDetails: undefined,
  };
}

function makeToolGroup(id: number, callIds: string[]): HistoryItem {
  return {
    id,
    type: 'tool_group',
    tools: callIds.map(makeToolCall),
  } as HistoryItem;
}

function makeAncillary(id: number, toolCallId: string): HistoryItem {
  return {
    id,
    type: 'custom_content',
    content: null,
    isAncillary: true,
    toolCallId,
  } as unknown as HistoryItem;
}

function makeGemini(id: number): HistoryItem {
  return { id, type: 'gemini', text: 'response' } as HistoryItem;
}

describe('reorderHistoryItems', () => {
  it('returns same reference when no ancillary items exist', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, ['c1']),
      makeGemini(2),
      makeToolGroup(3, ['c2']),
    ];
    expect(reorderHistoryItems(history)).toBe(history);
  });

  it('returns same reference for empty input', () => {
    const history: HistoryItem[] = [];
    expect(reorderHistoryItems(history)).toBe(history);
  });

  it('returns same reference when no tool_groups exist', () => {
    const history: HistoryItem[] = [
      makeGemini(1),
      makeAncillary(2, 'c1'),
    ];
    expect(reorderHistoryItems(history)).toBe(history);
  });

  it('relocates ancillary item to after its tool_group', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, ['c1']),
      makeGemini(2),
      makeAncillary(3, 'c1'),
    ];

    const result = reorderHistoryItems(history);
    expect(result.length).toBe(3);
    expect(result[0].type).toBe('tool_group');
    expect(result[1].id).toBe(3); // ancillary moved here
    expect(result[2].type).toBe('gemini');
  });

  it('does not relocate ancillary when tool_group appears later', () => {
    const history: HistoryItem[] = [
      makeAncillary(1, 'c1'),
      makeToolGroup(2, ['c1']),
    ];

    // groupIndex (1) is not < item index (0), so no move
    expect(reorderHistoryItems(history)).toBe(history);
  });

  it('relocates multiple ancillary items to the same group', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, ['c1', 'c2']),
      makeGemini(2),
      makeAncillary(3, 'c1'),
      makeAncillary(4, 'c2'),
    ];

    const result = reorderHistoryItems(history);
    expect(result.length).toBe(4);
    expect(result[0].type).toBe('tool_group');
    expect(result[1].id).toBe(3); // first ancillary
    expect(result[2].id).toBe(4); // second ancillary
    expect(result[3].type).toBe('gemini');
  });

  it('does not relocate non-ancillary items', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, ['c1']),
      makeGemini(2),
      { id: 3, type: 'info', text: 'something', toolCallId: 'c1' } as HistoryItem,
    ];

    // isAncillary is not set, so no relocation
    expect(reorderHistoryItems(history)).toBe(history);
  });
});
