/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistory, UI_COMPACT_CLEARED_MESSAGE } from './useHistoryManager.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import type { HistoryItemWithoutId, HistoryItemToolGroup } from '../types.js';
import { ToolCallStatus } from '../types.js';

const { debugLoggerMock } = vi.hoisted(() => ({
  debugLoggerMock: {
    isEnabled: vi.fn().mockReturnValue(true),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => debugLoggerMock,
}));

describe('useHistoryManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with an empty history', () => {
    const { result } = renderHook(() => useHistory());
    expect(result.current.history).toEqual([]);
  });

  it('should add an item to history with a unique ID', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const itemData: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Hello',
    };

    act(() => {
      result.current.addItem(itemData, timestamp);
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]).toEqual(
      expect.objectContaining({
        ...itemData,
        id: expect.any(Number),
      }),
    );
    // Basic check that ID incorporates timestamp
    expect(result.current.history[0].id).toBeGreaterThanOrEqual(timestamp);
  });

  it('should generate unique IDs for items added with the same base timestamp', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const itemData1: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'First',
    };
    const itemData2: HistoryItemWithoutId = {
      type: 'gemini', // Replaced HistoryItemType.Gemini
      text: 'Second',
    };

    let id1!: number;
    let id2!: number;

    act(() => {
      id1 = result.current.addItem(itemData1, timestamp);
      id2 = result.current.addItem(itemData2, timestamp);
    });

    expect(result.current.history).toHaveLength(2);
    expect(id1).not.toEqual(id2);
    expect(result.current.history[0].id).toEqual(id1);
    expect(result.current.history[1].id).toEqual(id2);
    // IDs should be sequential based on the counter
    expect(id2).toBeGreaterThan(id1);
  });

  it('should update an existing history item', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const initialItem: HistoryItemWithoutId = {
      type: 'gemini', // Replaced HistoryItemType.Gemini
      text: 'Initial content',
    };
    let itemId!: number;

    act(() => {
      itemId = result.current.addItem(initialItem, timestamp);
    });

    const updatedText = 'Updated content';
    act(() => {
      result.current.updateItem(itemId, { text: updatedText });
    });

    expect(result.current.history).toHaveLength(1);
    expect(result.current.history[0]).toEqual({
      ...initialItem,
      id: itemId,
      text: updatedText,
    });
  });

  it('should not change history if updateHistoryItem is called with a nonexistent ID', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const itemData: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Hello',
    };

    act(() => {
      result.current.addItem(itemData, timestamp);
    });

    const originalHistory = [...result.current.history]; // Clone before update attempt
    const originalHistoryRef = result.current.history;

    act(() => {
      result.current.updateItem(99999, { text: 'Should not apply' }); // Nonexistent ID
    });

    expect(result.current.history).toEqual(originalHistory);
    expect(result.current.history).toBe(originalHistoryRef);
    expect(debugLoggerMock.debug).toHaveBeenCalledWith(
      'Skipped history update; item 99999 was not found.',
    );
  });

  it('should clear the history', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const itemData1: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'First',
    };
    const itemData2: HistoryItemWithoutId = {
      type: 'gemini', // Replaced HistoryItemType.Gemini
      text: 'Second',
    };

    act(() => {
      result.current.addItem(itemData1, timestamp);
      result.current.addItem(itemData2, timestamp);
    });

    expect(result.current.history).toHaveLength(2);

    act(() => {
      result.current.clearItems();
    });

    expect(result.current.history).toEqual([]);
  });

  it('should not add consecutive duplicate user messages', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const itemData1: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Duplicate message',
    };
    const itemData2: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Duplicate message',
    };
    const itemData3: HistoryItemWithoutId = {
      type: 'gemini', // Replaced HistoryItemType.Gemini
      text: 'Gemini response',
    };
    const itemData4: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Another user message',
    };

    act(() => {
      result.current.addItem(itemData1, timestamp);
      result.current.addItem(itemData2, timestamp + 1); // Same text, different timestamp
      result.current.addItem(itemData3, timestamp + 2);
      result.current.addItem(itemData4, timestamp + 3);
    });

    expect(result.current.history).toHaveLength(3);
    expect(result.current.history[0].text).toBe('Duplicate message');
    expect(result.current.history[1].text).toBe('Gemini response');
    expect(result.current.history[2].text).toBe('Another user message');
  });

  it('should add duplicate user messages if they are not consecutive', () => {
    const { result } = renderHook(() => useHistory());
    const timestamp = Date.now();
    const itemData1: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Message 1',
    };
    const itemData2: HistoryItemWithoutId = {
      type: 'gemini', // Replaced HistoryItemType.Gemini
      text: 'Gemini response',
    };
    const itemData3: HistoryItemWithoutId = {
      type: 'user', // Replaced HistoryItemType.User
      text: 'Message 1', // Duplicate text, but not consecutive
    };

    act(() => {
      result.current.addItem(itemData1, timestamp);
      result.current.addItem(itemData2, timestamp + 1);
      result.current.addItem(itemData3, timestamp + 2);
    });

    expect(result.current.history).toHaveLength(3);
    expect(result.current.history[0].text).toBe('Message 1');
    expect(result.current.history[1].text).toBe('Gemini response');
    expect(result.current.history[2].text).toBe('Message 1');
  });

  describe('compactOldItems', () => {
    function addThoughts(
      result: { current: UseHistoryManagerReturn },
      count: number,
      baseTimestamp: number,
    ) {
      for (let i = 0; i < count; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'gemini_thought_content',
              text: `thought-${i}`,
            } as HistoryItemWithoutId,
            baseTimestamp + i,
          );
        });
      }
    }

    it('should keep the most recent 20 thought items and drop older ones', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      addThoughts(result, 30, ts);

      expect(result.current.history).toHaveLength(30);

      act(() => {
        result.current.compactOldItems();
      });

      expect(result.current.history).toHaveLength(20);
      // The kept items should be the NEWEST (thought-10 through thought-29)
      expect(result.current.history[0]).toEqual(
        expect.objectContaining({ text: 'thought-10' }),
      );
      expect(result.current.history[19]).toEqual(
        expect.objectContaining({ text: 'thought-29' }),
      );
    });

    it('should not remove thoughts when total <= 20', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      addThoughts(result, 15, ts);
      expect(result.current.history).toHaveLength(15);

      act(() => {
        result.current.compactOldItems();
      });

      expect(result.current.history).toHaveLength(15);
    });

    it('should clear string resultDisplay on old tool_group items', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add 25 tool_groups so the first ones fall outside keep-recent-20
      for (let i = 0; i < 25; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'read_file',
                  description: '',
                  resultDisplay: 'some file content here',
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      act(() => {
        result.current.compactOldItems();
      });

      // First 5 (oldest) should be compacted
      const tool = (
        result.current.history[0] as unknown as HistoryItemToolGroup
      ).tools[0];
      expect(tool.resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      // Last 20 (newest) should be untouched
      const recentTool = (
        result.current.history[24] as unknown as HistoryItemToolGroup
      ).tools[0];
      expect(recentTool.resultDisplay).toBe('some file content here');
    });

    it('should blank fileDiff object on old tool_group items', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add 25 tool_groups so the first ones fall outside keep-recent-20
      for (let i = 0; i < 25; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'edit',
                  description: '',
                  resultDisplay: {
                    fileDiff: '--- a/foo\n+++ b/foo\n@@ -1 +1 @@',
                    originalContent: 'old',
                    newContent: 'new',
                  },
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      act(() => {
        result.current.compactOldItems();
      });

      // First (oldest) should be replaced with cleared message
      const tool = (
        result.current.history[0] as unknown as HistoryItemToolGroup
      ).tools[0];
      expect(tool.resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
    });

    it('should return same reference for empty history', () => {
      const { result } = renderHook(() => useHistory());

      const before = result.current.history;
      act(() => {
        result.current.compactOldItems();
      });
      const after = result.current.history;

      expect(after).toBe(before);
    });

    it('should keep the most recent 20 tool_group items un-compacted', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add 30 tool_groups with string resultDisplay
      for (let i = 0; i < 30; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'read_file',
                  description: '',
                  resultDisplay: `content-${i}`,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      act(() => {
        result.current.compactOldItems();
      });

      // First 10 (oldest) should be compacted
      for (let i = 0; i < 10; i++) {
        const tool = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools[0];
        expect(tool.resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      }
      // Last 20 (newest) should be untouched
      for (let i = 10; i < 30; i++) {
        const tool = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools[0];
        expect(tool.resultDisplay).toBe(`content-${i}`);
      }
    });

    it('should handle mixed-type history (interleaved thoughts + tool_groups)', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add interleaved thoughts and tool_groups
      for (let i = 0; i < 30; i++) {
        act(() => {
          // Add thought
          result.current.addItem(
            {
              type: 'gemini_thought_content',
              text: `thought-${i}`,
            } as HistoryItemWithoutId,
            ts + i * 2,
          );
          // Add tool_group
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'read_file',
                  description: '',
                  resultDisplay: `content-${i}`,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i * 2 + 1,
          );
        });
      }

      expect(result.current.history).toHaveLength(60);

      act(() => {
        result.current.compactOldItems();
      });

      // compactOldItems keeps most recent 20 of each type
      // With 30 thoughts: removes 10 oldest
      // With 30 tool_groups: compacts 10 oldest (replaces resultDisplay)
      const remainingThoughts = result.current.history.filter(
        (item) =>
          item.type === 'gemini_thought' ||
          item.type === 'gemini_thought_content',
      );
      const remainingToolGroups = result.current.history.filter(
        (item) => item.type === 'tool_group',
      );

      // 10 thoughts removed, 20 kept
      expect(remainingThoughts).toHaveLength(20);
      // All 30 tool_groups kept (but 10 have resultDisplay replaced)
      expect(remainingToolGroups).toHaveLength(30);

      // The kept thoughts should be the newest ones
      expect(remainingThoughts[0]).toEqual(
        expect.objectContaining({ text: 'thought-10' }),
      );

      // First 10 tool_groups should have resultDisplay compacted
      for (let i = 0; i < 10; i++) {
        const tool = (remainingToolGroups[i] as unknown as HistoryItemToolGroup)
          .tools[0];
        expect(tool.resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      }

      // Last 20 tool_groups should be untouched
      for (let i = 10; i < 30; i++) {
        const tool = (remainingToolGroups[i] as unknown as HistoryItemToolGroup)
          .tools[0];
        expect(tool.resultDisplay).toBe(`content-${i}`);
      }
    });

    it('should compact gemini_thought type (not just gemini_thought_content)', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add 30 gemini_thought items
      for (let i = 0; i < 30; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'gemini_thought',
              text: `thought-${i}`,
            } as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      expect(result.current.history).toHaveLength(30);

      act(() => {
        result.current.compactOldItems();
      });

      // Should keep only 20
      expect(result.current.history).toHaveLength(20);
      expect(result.current.history[0]).toEqual(
        expect.objectContaining({ text: 'thought-10' }),
      );
    });

    it('should compact non-string resultDisplay types (TodoResultDisplay, AnsiOutputDisplay)', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add tool_groups with various resultDisplay types
      for (let i = 0; i < 25; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'tool',
                  description: '',
                  resultDisplay:
                    i % 3 === 0
                      ? { type: 'todo', items: ['item1'] } // TodoResultDisplay
                      : i % 3 === 1
                        ? { ansiOutput: '\x1b[31mred\x1b[0m' } // AnsiOutputDisplay
                        : { type: 'task_execution', result: 'data' }, // AgentResultDisplay
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      act(() => {
        result.current.compactOldItems();
      });

      // First 5 (oldest) should be compacted
      for (let i = 0; i < 5; i++) {
        const tool = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools[0];
        expect(tool.resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      }

      // Last 20 (newest) should be untouched
      for (let i = 5; i < 25; i++) {
        const tool = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools[0];
        expect(tool.resultDisplay).not.toBe(UI_COMPACT_CLEARED_MESSAGE);
      }
    });

    it('should not compact tool_groups with null resultDisplay', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add 25 tool_groups with null resultDisplay
      for (let i = 0; i < 25; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'tool',
                  description: '',
                  resultDisplay: null,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      const before = result.current.history;

      act(() => {
        result.current.compactOldItems();
      });

      // Should not compact since all resultDisplay are null
      expect(result.current.history).toBe(before);
    });

    it('should not compact non-compactable types (Retry, Notification)', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // Add various non-compactable types
      const nonCompactableTypes = ['retry', 'notification', 'user', 'gemini'];

      for (let i = 0; i < 30; i++) {
        act(() => {
          result.current.addItem(
            {
              type: nonCompactableTypes[
                i % nonCompactableTypes.length
              ] as HistoryItemWithoutId['type'],
              text: `item-${i}`,
            } as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      const before = result.current.history;

      act(() => {
        result.current.compactOldItems();
      });

      // Should not compact non-compactable types
      expect(result.current.history).toBe(before);
    });

    it('should not re-compact already-compacted tool groups (idempotent)', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // 15 already-compacted + 15 fresh tool_groups = 30 total
      for (let i = 0; i < 15; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'read_file',
                  description: '',
                  resultDisplay: UI_COMPACT_CLEARED_MESSAGE,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }
      for (let i = 15; i < 30; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'read_file',
                  description: '',
                  resultDisplay: `content-${i}`,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      act(() => {
        result.current.compactOldItems();
      });

      // totalToolGroupsWithOutput = 15 (only fresh ones), toolGroupsToCompact = 0
      // → no additional compaction, all 30 items kept
      expect(result.current.history).toHaveLength(30);

      // Already-compacted items should still be the cleared message
      for (let i = 0; i < 15; i++) {
        const tool = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools[0];
        expect(tool.resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      }

      // Fresh items should remain untouched
      for (let i = 15; i < 30; i++) {
        const tool = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools[0];
        expect(tool.resultDisplay).toBe(`content-${i}`);
      }

      // Second call should be a no-op (same reference)
      const before = result.current.history;
      act(() => {
        result.current.compactOldItems();
      });
      expect(result.current.history).toBe(before);
    });

    it('should handle all tool groups already compacted', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      for (let i = 0; i < 30; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: String(i),
                  name: 'read_file',
                  description: '',
                  resultDisplay: UI_COMPACT_CLEARED_MESSAGE,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      const before = result.current.history;

      act(() => {
        result.current.compactOldItems();
      });

      // totalToolGroupsWithOutput = 0, nothing to compact
      expect(result.current.history).toBe(before);
    });

    it('should handle tool group with mixed output (some tools real, some cleared)', () => {
      const { result } = renderHook(() => useHistory());
      const ts = Date.now();

      // 25 tool_groups, each with 2 tools: one with output, one cleared
      for (let i = 0; i < 25; i++) {
        act(() => {
          result.current.addItem(
            {
              type: 'tool_group',
              tools: [
                {
                  callId: `${i}-a`,
                  name: 'read_file',
                  description: '',
                  resultDisplay: `content-${i}`,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
                {
                  callId: `${i}-b`,
                  name: 'edit',
                  description: '',
                  resultDisplay: UI_COMPACT_CLEARED_MESSAGE,
                  status: ToolCallStatus.Success,
                  confirmationDetails: undefined,
                },
              ],
            } as unknown as HistoryItemWithoutId,
            ts + i,
          );
        });
      }

      act(() => {
        result.current.compactOldItems();
      });

      // totalToolGroupsWithOutput = 25 (hasOldOutput is true because tool[0] has real output)
      // toolGroupsToCompact = max(0, 25 - 20) = 5
      // First 5 should be compacted: both tools get resultDisplay replaced
      for (let i = 0; i < 5; i++) {
        const tools = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools;
        expect(tools[0].resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
        expect(tools[1].resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      }

      // Last 20 should be untouched
      for (let i = 5; i < 25; i++) {
        const tools = (
          result.current.history[i] as unknown as HistoryItemToolGroup
        ).tools;
        expect(tools[0].resultDisplay).toBe(`content-${i}`);
        expect(tools[1].resultDisplay).toBe(UI_COMPACT_CLEARED_MESSAGE);
      }
    });
  });
});
