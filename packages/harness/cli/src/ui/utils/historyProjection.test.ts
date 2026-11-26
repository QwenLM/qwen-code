/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CoreToolCallStatus,
  MessageType,
  type HistoryItem,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
} from '../types.js';
import { anchoredWindow } from './anchoredWindow.js';
import {
  buildPendingHistoryItems,
  computeSuppressNarrationFlags,
  projectHistoryForDisplay,
} from './historyProjection.js';

describe('projectHistoryForDisplay', () => {
  it('computes narration flags against the projected item order', () => {
    const history: HistoryItem[] = [
      { id: 1, type: 'user', text: 'prompt' },
      {
        id: 2,
        type: 'thinking',
        thought: { subject: 'Thinking', description: 'narration' },
      },
      {
        id: 3,
        type: 'tool_group',
        tools: [
          {
            callId: 'topic-1',
            name: 'update_topic',
            description: 'topic',
            status: CoreToolCallStatus.Success,
            resultDisplay: undefined,
            confirmationDetails: undefined,
          },
        ],
      },
    ];

    expect(
      computeSuppressNarrationFlags(
        history,
        true,
        (name) => name === 'update_topic',
      ),
    ).toEqual([false, true, false]);
    expect(
      computeSuppressNarrationFlags(history, false, () => true),
    ).toEqual([false, false, false]);
  });

  it('preserves hidden predecessor context at an anchored window boundary', () => {
    const history: HistoryItem[] = Array.from(
      { length: 61 },
      (_, index): HistoryItem => ({
        id: index + 1,
        type: 'user',
        text: `item-${index + 1}`,
      }),
    );
    history[10] = {
      id: 11,
      type: 'tool_group',
      tools: [],
    };
    history[11] = {
      id: 12,
      type: 'thinking',
      thought: { subject: 'Thinking', description: 'continued' },
    };
    const flags = new Array<boolean>(history.length).fill(false);
    flags[11] = true;

    const projected = projectHistoryForDisplay(history, flags);
    const window = anchoredWindow(projected, null, {
      capacity: 50,
      step: 10,
      keyOf: (entry) => entry.item.id,
    });

    expect(window.startIndex).toBe(11);
    expect(window.items[0]).toMatchObject({
      item: { id: 12 },
      isFirstThinking: true,
      isToolGroupBoundary: true,
      suppressNarration: true,
      prevCategory: 'tool-group',
    });
  });

  it('does not restart a thinking group when its predecessor is hidden', () => {
    const history: HistoryItem[] = Array.from(
      { length: 61 },
      (_, index): HistoryItem => ({
        id: index + 1,
        type: 'user',
        text: `item-${index + 1}`,
      }),
    );
    history[10] = {
      id: 11,
      type: 'thinking',
      thought: { subject: 'Thinking', description: 'part one' },
    };
    history[11] = {
      id: 12,
      type: 'thinking',
      thought: { subject: 'Thinking', description: 'part two' },
    };

    const projected = projectHistoryForDisplay(history, []);
    const window = anchoredWindow(projected, null, {
      capacity: 50,
      step: 10,
      keyOf: (entry) => entry.item.id,
    });

    expect(window.items[0]?.isFirstThinking).toBe(false);
    expect(window.items[0]?.prevCategory).toBe('thinking');
  });

  it('preserves predecessor metadata when projection starts after a raw window', () => {
    const predecessor: HistoryItem = {
      id: 1,
      type: 'tool_group',
      tools: [],
    };
    const visible: HistoryItem[] = [
      {
        id: 2,
        type: 'thinking',
        thought: { subject: 'Thinking', description: 'continued' },
      },
    ];

    expect(projectHistoryForDisplay(visible, [], predecessor)[0]).toMatchObject(
      {
        isFirstThinking: true,
        isToolGroupBoundary: true,
        prevCategory: 'tool-group',
      },
    );
  });
});

describe('buildPendingHistoryItems', () => {
  const thought = { subject: 'Thinking', description: 'Working on it' };
  const emptyState = {
    pendingDisplayHistory: null,
    pendingAssistantText: '',
    pendingApprovalTools: [],
    thought: null,
  };
  const makeTool = (
    callId: string,
    correlationId?: string,
  ): IndividualToolCallDisplay => ({
    callId,
    correlationId,
    name: 'ask_user',
    description: 'Waiting for an answer',
    status: CoreToolCallStatus.AwaitingApproval,
    resultDisplay: undefined,
    confirmationDetails: undefined,
  });

  it('orders fallback thinking, assistant text and approvals', () => {
    const tool = makeTool('call-1');
    expect(
      buildPendingHistoryItems({
        pendingDisplayHistory: null,
        pendingAssistantText: 'Hello',
        pendingApprovalTools: [tool],
        thought,
      }),
    ).toEqual([
      { type: 'thinking', thought },
      { type: MessageType.GEMINI, text: 'Hello' },
      { type: 'tool_group', tools: [tool] },
    ]);
    expect(buildPendingHistoryItems(emptyState)).toEqual([]);
  });

  it('prefers display items over fallback text and thinking and filters model queue items', () => {
    const displayed: HistoryItemWithoutId = {
      type: MessageType.GEMINI,
      text: 'Already projected',
    };
    expect(
      buildPendingHistoryItems({
        ...emptyState,
        pendingDisplayHistory: [
          {
            type: MessageType.MODEL_QUEUE,
            modelQueue: { status: 'queued', progress: 55 },
          },
          displayed,
        ],
        pendingAssistantText: 'Fallback text',
        thought,
      }),
    ).toEqual([displayed]);
  });

  it('keeps an empty display snapshot authoritative while still showing approvals', () => {
    const state = {
      ...emptyState,
      pendingDisplayHistory: [],
      pendingAssistantText: 'Fallback text',
      thought,
    };
    expect(buildPendingHistoryItems(state)).toEqual([]);
    const tool = makeTool('call-1');
    expect(
      buildPendingHistoryItems({ ...state, pendingApprovalTools: [tool] }),
    ).toEqual([{ type: 'tool_group', tools: [tool] }]);
  });

  it.each([
    {
      name: 'matches correlation IDs even when call IDs differ',
      displayed: makeTool('display-call', 'request-1'),
      pending: makeTool('pending-call', 'request-1'),
      missing: false,
    },
    {
      name: 'matches call IDs when correlation IDs are absent',
      displayed: makeTool('call-1'),
      pending: makeTool('call-1'),
      missing: false,
    },
    {
      name: 'keeps different correlation IDs even when call IDs match',
      displayed: makeTool('call-1', 'request-1'),
      pending: makeTool('call-1', 'request-2'),
      missing: true,
    },
    {
      name: 'keeps a live approval when its display snapshot lacks the request ID',
      displayed: makeTool('call-1'),
      pending: makeTool('call-1', 'request-1'),
      missing: true,
    },
    {
      name: 'keeps an uncorrelated approval separate from a correlated display',
      displayed: makeTool('call-1', 'request-1'),
      pending: makeTool('call-1'),
      missing: true,
    },
    {
      name: 'keeps correlation IDs separate from matching call IDs',
      displayed: makeTool('display-call', 'shared-id'),
      pending: makeTool('shared-id'),
      missing: true,
    },
    {
      name: 'falls back to call IDs for empty correlation IDs',
      displayed: makeTool('call-1', ''),
      pending: makeTool('call-1'),
      missing: false,
    },
  ])('$name', ({ displayed, pending, missing }) => {
    const displayItem: HistoryItemWithoutId = {
      type: 'tool_group',
      tools: [displayed],
    };
    expect(
      buildPendingHistoryItems({
        ...emptyState,
        pendingDisplayHistory: [displayItem],
        pendingApprovalTools: [pending],
      }),
    ).toEqual(
      missing
        ? [displayItem, { type: 'tool_group', tools: [pending] }]
        : [displayItem],
    );
  });

  it('appends only missing approvals in input order without changing the inputs', () => {
    const displayedTool = makeTool('call-1', 'request-1');
    const missingTools = [makeTool('call-2'), makeTool('call-3')];
    const displayItems: HistoryItemWithoutId[] = [
      { type: 'tool_group', tools: [displayedTool] },
      { type: MessageType.GEMINI, text: 'Already projected' },
    ];
    const pendingTools = [missingTools[0], displayedTool, missingTools[1]];
    Object.freeze(displayedTool);
    const toolGroup = displayItems[0];
    if (toolGroup.type === 'tool_group') Object.freeze(toolGroup.tools);
    displayItems.forEach(Object.freeze);
    Object.freeze(displayItems);
    pendingTools.forEach(Object.freeze);
    Object.freeze(pendingTools);

    const result = buildPendingHistoryItems({
      ...emptyState,
      pendingDisplayHistory: displayItems,
      pendingApprovalTools: pendingTools,
    });

    expect(result).toEqual([
      ...displayItems,
      { type: 'tool_group', tools: missingTools },
    ]);
    expect(result[0]).toBe(displayItems[0]);
    expect(result[1]).toBe(displayItems[1]);
    expect(pendingTools).toEqual([
      missingTools[0],
      displayedTool,
      missingTools[1],
    ]);
  });
});
