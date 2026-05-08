/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { mergeCompactToolGroups } from './mergeCompactToolGroups.js';
import type {
  HistoryItem,
  HistoryItemToolGroup,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';

// Helper to create tool_group history items
function createToolGroup(
  id: number,
  tools: IndividualToolCallDisplay[],
  isUserInitiated?: boolean,
): HistoryItem {
  return {
    type: 'tool_group',
    id,
    tools,
    isUserInitiated,
  };
}

function createTool(
  callId: string,
  name: string,
  status: ToolCallStatus,
  resultDisplay?: unknown,
  ptyId?: number,
): IndividualToolCallDisplay {
  return {
    callId,
    name,
    description: `${name} description`,
    status,
    resultDisplay: resultDisplay as IndividualToolCallDisplay['resultDisplay'],
    confirmationDetails: undefined,
    ptyId,
  };
}

// Type guard for tool_group
function isToolGroup(
  item: HistoryItem,
): item is HistoryItemToolGroup & { id: number } {
  return item.type === 'tool_group';
}

describe('mergeCompactToolGroups', () => {
  it('returns empty array unchanged', () => {
    expect(mergeCompactToolGroups([])).toEqual([]);
  });

  it('returns single tool_group unchanged', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [
        createTool('c1', 'Shell', ToolCallStatus.Success, 'output'),
      ]),
    ];
    expect(mergeCompactToolGroups(items)).toEqual(items);
  });

  it('returns single non-tool-group unchanged', () => {
    const items: HistoryItem[] = [{ type: 'user', id: 1, text: 'hello' }];
    expect(mergeCompactToolGroups(items)).toEqual(items);
  });

  it('merges two consecutive mergeable tool_groups', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [
        createTool('c1', 'Shell', ToolCallStatus.Success, 'output1'),
      ]),
      createToolGroup(2, [
        createTool('c2', 'Shell', ToolCallStatus.Success, 'output2'),
      ]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(1);
    expect(merged[0].type).toBe('tool_group');
    expect(merged[0].id).toBe(1); // First group's id preserved
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(2);
      expect(merged[0].tools[0].callId).toBe('c1');
      expect(merged[0].tools[1].callId).toBe('c2');
    }
  });

  it('merges multiple consecutive mergeable groups', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(2, [createTool('c2', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(3, [createTool('c3', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(1);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(3);
    }
    expect(merged[0].id).toBe(1);
  });

  it('does NOT merge across non-tool-group item', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      { type: 'gemini', id: 2, text: 'response' },
      createToolGroup(3, [createTool('c2', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(3);
    expect(merged[0].type).toBe('tool_group');
    expect(merged[1].type).toBe('gemini');
    expect(merged[2].type).toBe('tool_group');
  });

  it('does NOT merge user-initiated tool_group', () => {
    const items: HistoryItem[] = [
      createToolGroup(
        1,
        [createTool('c1', 'Shell', ToolCallStatus.Success)],
        false,
      ),
      createToolGroup(
        2,
        [createTool('c2', 'Shell', ToolCallStatus.Success)],
        true,
      ), // user-initiated
      createToolGroup(
        3,
        [createTool('c3', 'Shell', ToolCallStatus.Success)],
        false,
      ),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(3);
    // Groups 1 and 2 stay separate because 2 is user-initiated
    // Group 3 stays separate because streak was broken
  });

  it('does NOT merge tool_group with error tool', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(2, [
        createTool('c2', 'Shell', ToolCallStatus.Error, 'error output'),
      ]),
      createToolGroup(3, [createTool('c3', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(3);
    // Group 2 with error stays separate
  });

  it('does NOT merge tool_group with confirming tool', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(2, [
        createTool('c2', 'Shell', ToolCallStatus.Confirming),
      ]),
      createToolGroup(3, [createTool('c3', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(3);
    // Group 2 with confirmation stays separate
  });

  it('does NOT merge tool_group with subagent pending confirmation', () => {
    const subagentResult = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'test task',
      status: 'running',
      pendingConfirmation: { someData: true },
    };

    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(2, [
        createTool('c2', 'Agent', ToolCallStatus.Executing, subagentResult),
      ]),
      createToolGroup(3, [createTool('c3', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(3);
    // Group 2 with subagent pending confirmation stays separate
  });

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
  ] as const)(
    'does NOT merge tool_group with terminal subagent (%s)',
    (_label, status) => {
      // Terminal task_execution groups must not be absorbed: their
      // SubagentScrollbackSummary lands inline as the persistent
      // record of the run's outcome, and the compact path can't
      // surface it. Mirrors `hasTerminalSubagent` in
      // `ToolGroupMessage.showCompact`.
      const subagentResult = {
        type: 'task_execution',
        subagentName: 'test-agent',
        taskDescription: 'test task',
        status,
      };
      const items: HistoryItem[] = [
        createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
        createToolGroup(2, [
          createTool(
            'c2',
            'Agent',
            status === 'failed' ? ToolCallStatus.Error : ToolCallStatus.Success,
            subagentResult,
          ),
        ]),
        createToolGroup(3, [createTool('c3', 'Shell', ToolCallStatus.Success)]),
      ];
      const merged = mergeCompactToolGroups(items);
      // Three separate groups: terminal subagent stays its own batch
      // so SubagentScrollbackSummary renders as a standalone entry.
      expect(merged.length).toBe(3);
      const ids = merged
        .filter(isToolGroup)
        .map((g) => g.id)
        .sort();
      expect(ids).toEqual([1, 2, 3]);
    },
  );

  it('does NOT merge focused executing shell', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(2, [
        createTool('c2', 'Shell', ToolCallStatus.Executing, 'output', 123),
      ]), // active shell
      createToolGroup(3, [createTool('c3', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items, true, 123); // shell focused, ptyId=123

    expect(merged.length).toBe(3);
    // Group 2 with active shell stays separate
  });

  it('merges mixed tool types (Shell + Read)', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      createToolGroup(2, [
        createTool('c2', 'Read', ToolCallStatus.Success, 'file content'),
      ]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(1);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(2);
      expect(merged[0].tools[0].name).toBe('Shell');
      expect(merged[0].tools[1].name).toBe('Read');
    }
  });

  it('preserves all tool properties after merge', () => {
    const tool1 = createTool('c1', 'Shell', ToolCallStatus.Success, 'output1');
    tool1.renderOutputAsMarkdown = true;

    const tool2 = createTool('c2', 'Read', ToolCallStatus.Success, 'output2');
    tool2.renderOutputAsMarkdown = false;

    const items: HistoryItem[] = [
      createToolGroup(1, [tool1]),
      createToolGroup(2, [tool2]),
    ];

    const merged = mergeCompactToolGroups(items);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools[0].renderOutputAsMarkdown).toBe(true);
      expect(merged[0].tools[1].renderOutputAsMarkdown).toBe(false);
    }
  });

  it('merges tool_groups with multiple tools each', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [
        createTool('c1', 'Shell', ToolCallStatus.Success),
        createTool('c2', 'Read', ToolCallStatus.Success),
      ]),
      createToolGroup(2, [
        createTool('c3', 'Shell', ToolCallStatus.Success),
        createTool('c4', 'Write', ToolCallStatus.Success),
      ]),
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(1);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(4);
      expect(merged[0].tools.map((t) => t.callId)).toEqual([
        'c1',
        'c2',
        'c3',
        'c4',
      ]);
    }
  });

  it('merges tool_groups separated by gemini_thought (hidden in compact)', () => {
    // This is the real-world case: model emits a thought between consecutive
    // tool calls. Since gemini_thought is hidden in compact mode, the user
    // visually sees adjacent boxes — so we merge them.
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      { type: 'gemini_thought', id: 2, text: 'thinking...' },
      createToolGroup(3, [createTool('c2', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    // The hidden gemini_thought between merged groups is dropped
    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe(1);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(2);
      expect(merged[0].tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
    }
  });

  it('merges 8 tool_groups each separated by a gemini_thought', () => {
    // Real scenario: 8 sequential shell commands, model thinks between each.
    const items: HistoryItem[] = [];
    for (let n = 0; n < 8; n++) {
      items.push(
        createToolGroup(n * 2 + 1, [
          createTool(`c${n}`, 'Shell', ToolCallStatus.Success),
        ]),
      );
      if (n < 7) {
        items.push({ type: 'gemini_thought', id: n * 2 + 2, text: 'thinking' });
      }
    }

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(1);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(8);
    }
  });

  it('does NOT merge across visible non-tool-group items (gemini text)', () => {
    // gemini text IS visible in compact mode → it breaks the streak
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      { type: 'gemini_thought', id: 2, text: 'thinking...' },
      { type: 'gemini', id: 3, text: 'visible response' }, // visible in compact
      createToolGroup(4, [createTool('c2', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(items);

    // Should not merge because of the visible 'gemini' item
    expect(merged.length).toBe(4);
    expect(merged[0].type).toBe('tool_group');
    expect(merged[1].type).toBe('gemini_thought');
    expect(merged[2].type).toBe('gemini');
    expect(merged[3].type).toBe('tool_group');
  });

  it('drops trailing tool_use_summary after a single absorbed tool_group', () => {
    // Single-batch turn: one tool_group, then its summary arrives. The group
    // is non-force-expanded (compact-mode candidate), so its callId is in
    // absorbedCallIds — the summary is consumed by the compact header and
    // dropped from merged output. Without this drop, mergedHistory.length
    // would grow lock-step with history.length and MainContent's
    // refreshStatic heuristic would never fire.
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      {
        type: 'tool_use_summary',
        id: 2,
        summary: 'Ran shell batch',
        precedingToolUseIds: ['c1'],
      },
    ];

    const merged = mergeCompactToolGroups(
      items,
      false,
      undefined,
      new Set(['c1']),
    );

    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe(1);
    expect(merged[0].type).toBe('tool_group');
  });

  it('drops absorbed trailing tool_use_summary even when followed by visible non-mergeable items', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      {
        type: 'tool_use_summary',
        id: 2,
        summary: 'Ran shell batch',
        precedingToolUseIds: ['c1'],
      },
      { type: 'user', id: 3, text: 'next prompt' },
    ];

    const merged = mergeCompactToolGroups(
      items,
      false,
      undefined,
      new Set(['c1']),
    );

    expect(merged.length).toBe(2);
    expect(merged[0].type).toBe('tool_group');
    expect(merged[1].type).toBe('user');
  });

  it('preserves tool_use_summary for force-expanded (non-absorbed) tool_group', () => {
    // The errored tool_group is force-expanded: it renders through the full
    // ToolGroupMessage path, ignoring `compactLabel`. Its callId is NOT in
    // absorbedCallIds, so the summary must survive in merged output —
    // HistoryItemDisplay then renders it as a standalone `● <label>` line,
    // which is the only way the label reaches the screen for this group.
    const items: HistoryItem[] = [
      createToolGroup(1, [
        createTool('c1', 'Shell', ToolCallStatus.Error, 'boom'),
      ]),
      {
        type: 'tool_use_summary',
        id: 2,
        summary: 'Tried shell batch',
        precedingToolUseIds: ['c1'],
      },
    ];

    // Empty absorbedCallIds — the errored group's callId is not absorbed.
    const merged = mergeCompactToolGroups(items, false, undefined, new Set());

    expect(merged.length).toBe(2);
    expect(merged[0].type).toBe('tool_group');
    expect(merged[1].type).toBe('tool_use_summary');
  });

  it('preserves tool_use_summary when no absorbedCallIds set is provided (default)', () => {
    // Default empty set — preserves all summaries. This is the safe default
    // for callers that don't compute absorption (e.g., older test fixtures
    // and any future callers outside MainContent).
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      {
        type: 'tool_use_summary',
        id: 2,
        summary: 'Ran shell batch',
        precedingToolUseIds: ['c1'],
      },
    ];

    const merged = mergeCompactToolGroups(items);

    expect(merged.length).toBe(2);
    expect(merged[0].type).toBe('tool_group');
    expect(merged[1].type).toBe('tool_use_summary');
  });

  it('merges tool_groups separated by tool_use_summary (hidden in compact)', () => {
    // Two mergeable batches separated by an absorbed summary — the summary
    // is dropped during merge, the two groups concatenate.
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      {
        type: 'tool_use_summary',
        id: 2,
        summary: 'Ran first shell batch',
        precedingToolUseIds: ['c1'],
      },
      createToolGroup(3, [createTool('c2', 'Shell', ToolCallStatus.Success)]),
    ];

    const merged = mergeCompactToolGroups(
      items,
      false,
      undefined,
      new Set(['c1', 'c2']),
    );

    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe(1);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.map((t) => t.callId)).toEqual(['c1', 'c2']);
    }
  });

  it('preserves trailing gemini_thought after merged group', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]),
      { type: 'gemini_thought', id: 2, text: 'thinking' },
      createToolGroup(3, [createTool('c2', 'Shell', ToolCallStatus.Success)]),
      { type: 'gemini_thought', id: 4, text: 'more thinking' },
    ];

    const merged = mergeCompactToolGroups(items);

    // Merged group + trailing gemini_thought
    expect(merged.length).toBe(2);
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(2);
    }
    expect(merged[1].type).toBe('gemini_thought');
  });

  it('handles complex sequence with mixed force-expand and mergeable', () => {
    const items: HistoryItem[] = [
      createToolGroup(1, [createTool('c1', 'Shell', ToolCallStatus.Success)]), // mergeable
      createToolGroup(2, [createTool('c2', 'Shell', ToolCallStatus.Success)]), // mergeable
      createToolGroup(3, [
        createTool('c3', 'Shell', ToolCallStatus.Error, 'error'),
      ]), // force-expand
      createToolGroup(4, [createTool('c4', 'Shell', ToolCallStatus.Success)]), // mergeable (streak broken)
      createToolGroup(
        5,
        [createTool('c5', 'Shell', ToolCallStatus.Success)],
        true,
      ), // user-initiated
      createToolGroup(6, [createTool('c6', 'Shell', ToolCallStatus.Success)]), // mergeable (streak broken)
    ];

    const merged = mergeCompactToolGroups(items);

    // Expected: 1+2 merged, 3 separate, 4 separate, 5 separate, 6 separate
    expect(merged.length).toBe(5);

    // First merged group (1+2)
    if (isToolGroup(merged[0])) {
      expect(merged[0].tools.length).toBe(2);
    }
    expect(merged[0].id).toBe(1);

    // Error group (3)
    if (isToolGroup(merged[1])) {
      expect(merged[1].tools[0].status).toBe(ToolCallStatus.Error);
    }

    // Groups 4, 5, 6 stay separate
    expect(merged[2].type).toBe('tool_group');
    expect(merged[3].type).toBe('tool_group');
    expect(merged[4].type).toBe('tool_group');
  });
});
