/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { collapseReadOnlyGroups } from './collapseReadOnlyGroups.js';
import type { HistoryItem, IndividualToolCallDisplay } from '../types.js';
import { CoreToolCallStatus, Kind } from '@qwen-code/core';

function makeToolCall(
  overrides: Partial<IndividualToolCallDisplay> = {},
): IndividualToolCallDisplay {
  return {
    callId: `call-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Read',
    description: 'Read a file',
    resultDisplay: 'file contents',
    status: CoreToolCallStatus.Success,
    kind: Kind.Read,
    confirmationDetails: undefined,
    ...overrides,
  };
}

function makeToolGroup(
  id: number,
  tools: IndividualToolCallDisplay[],
): HistoryItem {
  return {
    id,
    type: 'tool_group',
    tools,
  } as HistoryItem;
}

function makeUserItem(id: number, text = 'hello'): HistoryItem {
  return {
    id,
    type: 'user',
    text,
  } as HistoryItem;
}

function makeGeminiItem(id: number): HistoryItem {
  return {
    id,
    type: 'gemini',
    text: 'response',
  } as HistoryItem;
}

describe('collapseReadOnlyGroups', () => {
  it('returns the same array when no collapsing is possible', () => {
    const history: HistoryItem[] = [
      makeUserItem(1),
      makeToolGroup(2, [makeToolCall({ kind: Kind.Execute })]),
      makeGeminiItem(3),
    ];
    const result = collapseReadOnlyGroups(history);
    expect(result).toBe(history); // Same reference
  });

  it('returns the same array for empty input', () => {
    const result = collapseReadOnlyGroups([]);
    expect(result).toEqual([]);
  });

  it('does not collapse a single read-only group', () => {
    const history: HistoryItem[] = [
      makeUserItem(1),
      makeToolGroup(2, [makeToolCall({ kind: Kind.Read })]),
      makeGeminiItem(3),
    ];
    const result = collapseReadOnlyGroups(history);
    expect(result).toBe(history);
  });

  it('collapses two consecutive read-only groups into one', () => {
    const tool1 = makeToolCall({ kind: Kind.Read, name: 'Read' });
    const tool2 = makeToolCall({ kind: Kind.Search, name: 'Grep' });

    const history: HistoryItem[] = [
      makeUserItem(1),
      makeToolGroup(2, [tool1]),
      makeToolGroup(3, [tool2]),
      makeGeminiItem(4),
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(3); // user, merged group, gemini
    expect(result[1].type).toBe('tool_group');
    if (result[1].type === 'tool_group') {
      expect(result[1].tools).toHaveLength(2);
      expect(result[1].tools[0]).toBe(tool1);
      expect(result[1].tools[1]).toBe(tool2);
      expect(result[1].id).toBe(2); // Uses first group's id
    }
  });

  it('collapses three consecutive read-only groups', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(2, [makeToolCall({ kind: Kind.Search })]),
      makeToolGroup(3, [makeToolCall({ kind: Kind.Fetch })]),
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(1);
    if (result[0].type === 'tool_group') {
      expect(result[0].tools).toHaveLength(3);
    }
  });

  it('does not collapse groups containing mutating tools', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(2, [makeToolCall({ kind: Kind.Edit })]),
      makeToolGroup(3, [makeToolCall({ kind: Kind.Read })]),
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(3); // No collapsing
    expect(result).toBe(history);
  });

  it('does not collapse groups with executing tools', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(2, [
        makeToolCall({
          kind: Kind.Read,
          status: CoreToolCallStatus.Executing,
        }),
      ]),
      makeToolGroup(3, [makeToolCall({ kind: Kind.Read })]),
    ];

    const result = collapseReadOnlyGroups(history);
    // Group 2 is executing so breaks the chain. 1 and 3 are isolated singles.
    expect(result.length).toBe(3);
    expect(result).toBe(history);
  });

  it('handles a non-tool-group item breaking the chain', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(2, [makeToolCall({ kind: Kind.Read })]),
      makeGeminiItem(3),
      makeToolGroup(4, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(5, [makeToolCall({ kind: Kind.Read })]),
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(3); // merged group, gemini, merged group
    if (result[0].type === 'tool_group') {
      expect(result[0].tools).toHaveLength(2);
    }
    expect(result[1].type).toBe('gemini');
    if (result[2].type === 'tool_group') {
      expect(result[2].tools).toHaveLength(2);
    }
  });

  it('does not collapse groups with tools missing kind', () => {
    const history: HistoryItem[] = [
      makeToolGroup(1, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(2, [makeToolCall({ kind: undefined })]),
      makeToolGroup(3, [makeToolCall({ kind: Kind.Read })]),
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(3);
  });

  it('preserves non-tool_group items in the output', () => {
    const user = makeUserItem(1);
    const gemini = makeGeminiItem(4);

    const history: HistoryItem[] = [
      user,
      makeToolGroup(2, [makeToolCall({ kind: Kind.Read })]),
      makeToolGroup(3, [makeToolCall({ kind: Kind.Search })]),
      gemini,
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result[0]).toBe(user);
    expect(result[2]).toBe(gemini);
  });

  it('absorbs ancillary items bridging two read-only groups', () => {
    const tool1 = makeToolCall({ callId: 'c1', kind: Kind.Read });
    const tool2 = makeToolCall({ callId: 'c2', kind: Kind.Read });
    const hookWarning: HistoryItem = {
      id: 99,
      type: 'custom_content',
      content: null,
      isAncillary: true,
      toolCallId: 'c1',
    } as unknown as HistoryItem;

    const history: HistoryItem[] = [
      makeToolGroup(1, [tool1]),
      hookWarning,
      makeToolGroup(2, [tool2]),
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(1);
    if (result[0].type === 'tool_group') {
      expect(result[0].tools).toHaveLength(2);
    }
  });

  it('keeps trailing ancillary items visible after a single group', () => {
    const tool1 = makeToolCall({ callId: 'c1', kind: Kind.Read });
    const hookWarning: HistoryItem = {
      id: 99,
      type: 'custom_content',
      content: null,
      isAncillary: true,
      toolCallId: 'c1',
    } as unknown as HistoryItem;

    const history: HistoryItem[] = [
      makeToolGroup(1, [tool1]),
      hookWarning,
    ];

    const result = collapseReadOnlyGroups(history);
    expect(result.length).toBe(2);
    expect(result[1]).toBe(hookWarning);
  });

  it('does not absorb ancillary items with unrelated toolCallId', () => {
    const tool1 = makeToolCall({ callId: 'c1', kind: Kind.Read });
    const tool2 = makeToolCall({ callId: 'c2', kind: Kind.Read });
    const unrelatedHook: HistoryItem = {
      id: 99,
      type: 'custom_content',
      content: null,
      isAncillary: true,
      toolCallId: 'c-unrelated',
    } as unknown as HistoryItem;

    const history: HistoryItem[] = [
      makeToolGroup(1, [tool1]),
      unrelatedHook,
      makeToolGroup(2, [tool2]),
    ];

    const result = collapseReadOnlyGroups(history);
    // Unrelated hook breaks the chain — no merge
    expect(result.length).toBe(3);
  });

  it('does not absorb ancillary items with empty toolCallId', () => {
    const tool1 = makeToolCall({ callId: 'c1', kind: Kind.Read });
    const tool2 = makeToolCall({ callId: 'c2', kind: Kind.Read });
    const sessionHook: HistoryItem = {
      id: 99,
      type: 'custom_content',
      content: null,
      isAncillary: true,
      toolCallId: '',
    } as unknown as HistoryItem;

    const history: HistoryItem[] = [
      makeToolGroup(1, [tool1]),
      sessionHook,
      makeToolGroup(2, [tool2]),
    ];

    const result = collapseReadOnlyGroups(history);
    // Empty toolCallId means session-level — should not be absorbed
    expect(result.length).toBe(3);
  });
});
