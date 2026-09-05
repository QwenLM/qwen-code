/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { FindingsResultDisplay } from '@qwen-code/qwen-code-core';
import type {
  HistoryItemWithoutId,
  IndividualToolCallDisplay,
} from '../types.js';
import { ToolCallStatus } from '../types.js';
import {
  SUPERSEDED_FINDINGS_MESSAGE,
  coalesceFindingsHistoryItems,
  recoalesceFindingsHistoryItems,
} from './findings-coalescing.js';

const findingsDisplay = (findingId: string): FindingsResultDisplay => ({
  type: 'findings_list',
  findings: [
    {
      id: findingId,
      severity: 'Critical',
      file: 'src/foo.ts',
      summary: 's',
      shortSummary: 's',
      failureScenario: 'f',
    },
  ],
});

const findingsTool = (
  callId: string,
  resultDisplay: IndividualToolCallDisplay['resultDisplay'],
): IndividualToolCallDisplay => ({
  callId,
  name: 'report_findings',
  description: 'Report findings',
  resultDisplay,
  status: ToolCallStatus.Success,
  confirmationDetails: undefined,
});

const toolGroup = (tool: IndividualToolCallDisplay): HistoryItemWithoutId => ({
  type: 'tool_group',
  tools: [tool],
});

const userItem = (text: string): HistoryItemWithoutId => ({
  type: 'user',
  text,
});

describe('coalesceFindingsHistoryItems', () => {
  it('keeps the superseded display on the tool so a rewind can restore it', () => {
    const original = findingsDisplay('R1-1');
    const items = [
      toolGroup(findingsTool('call-1', original)),
      toolGroup(findingsTool('call-2', findingsDisplay('R2-1'))),
    ];

    const coalesced = coalesceFindingsHistoryItems(items);

    const first = coalesced[0] as Extract<
      HistoryItemWithoutId,
      { type: 'tool_group' }
    >;
    expect(first.tools[0].resultDisplay).toBe(SUPERSEDED_FINDINGS_MESSAGE);
    expect(first.tools[0].supersededFindingsDisplay).toBe(original);
  });

  it('keeps the original display when a third report supersedes again', () => {
    const original = findingsDisplay('R1-1');
    const once = coalesceFindingsHistoryItems([
      toolGroup(findingsTool('call-1', original)),
      toolGroup(findingsTool('call-2', findingsDisplay('R2-1'))),
    ]);
    const twice = coalesceFindingsHistoryItems([
      ...once,
      toolGroup(findingsTool('call-3', findingsDisplay('R3-1'))),
    ]);

    const first = twice[0] as Extract<
      HistoryItemWithoutId,
      { type: 'tool_group' }
    >;
    expect(first.tools[0].resultDisplay).toBe(SUPERSEDED_FINDINGS_MESSAGE);
    expect(first.tools[0].supersededFindingsDisplay).toBe(original);
  });
});

describe('recoalesceFindingsHistoryItems', () => {
  it('restores a superseded display whose replacing call was truncated away', () => {
    const original = findingsDisplay('R1-1');
    const coalesced = coalesceFindingsHistoryItems([
      userItem('first prompt'),
      toolGroup(findingsTool('call-1', original)),
      userItem('second prompt'),
      toolGroup(findingsTool('call-2', findingsDisplay('R2-1'))),
    ]);

    // The rewind slice: everything before the second user item.
    const truncated = coalesced.slice(0, 2);
    const repaired = recoalesceFindingsHistoryItems(truncated);

    const restored = repaired[1] as Extract<
      HistoryItemWithoutId,
      { type: 'tool_group' }
    >;
    expect(restored.tools[0].resultDisplay).toBe(original);
    expect(restored.tools[0].supersededFindingsDisplay).toBeUndefined();
  });

  it('keeps only the last list when both reports survive the truncation', () => {
    const first = findingsDisplay('R1-1');
    const second = findingsDisplay('R2-1');
    const coalesced = coalesceFindingsHistoryItems([
      toolGroup(findingsTool('call-1', first)),
      userItem('prompt'),
      toolGroup(findingsTool('call-2', second)),
    ]);

    const repaired = recoalesceFindingsHistoryItems(coalesced);

    const repairedFirst = repaired[0] as Extract<
      HistoryItemWithoutId,
      { type: 'tool_group' }
    >;
    const repairedSecond = repaired[2] as Extract<
      HistoryItemWithoutId,
      { type: 'tool_group' }
    >;
    expect(repairedFirst.tools[0].resultDisplay).toBe(
      SUPERSEDED_FINDINGS_MESSAGE,
    );
    expect(repairedFirst.tools[0].supersededFindingsDisplay).toBe(first);
    expect(repairedSecond.tools[0].resultDisplay).toBe(second);
  });

  it('returns the input unchanged when nothing is superseded', () => {
    const items = [
      userItem('prompt'),
      toolGroup(findingsTool('call-1', findingsDisplay('R1-1'))),
    ];
    expect(recoalesceFindingsHistoryItems(items)).toBe(items);
  });

  it('leaves a marker without a carried display alone', () => {
    const items = [
      toolGroup({
        ...findingsTool('call-1', SUPERSEDED_FINDINGS_MESSAGE),
      }),
    ];
    expect(recoalesceFindingsHistoryItems(items)).toBe(items);
  });
});
