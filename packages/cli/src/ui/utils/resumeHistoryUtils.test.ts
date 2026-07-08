/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyCollapsePolicyAndSummary,
  buildResumedHistoryItems,
  stripSuppressOnRestore,
  expandCollapsedHistory,
} from './resumeHistoryUtils.js';
import { MessageType, ToolCallStatus } from '../types.js';
import type {
  AnyDeclarativeTool,
  Config,
  ConversationRecord,
  ResumedSessionData,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import type { HistoryItem } from '../types.js';

const makeConfig = (tools: Record<string, AnyDeclarativeTool>) =>
  ({
    getToolRegistry: () => ({
      getTool: (name: string) => tools[name],
    }),
  }) as unknown as Config;

describe('resumeHistoryUtils', () => {
  let mockTool: AnyDeclarativeTool;

  beforeEach(() => {
    const mockInvocation = {
      getDescription: () => 'Mocked description',
    };

    mockTool = {
      name: 'replace',
      displayName: 'Replace',
      description: 'Replace text',
      build: vi.fn().mockReturnValue(mockInvocation),
    } as unknown as AnyDeclarativeTool;
  });

  it('inserts a history-gap divider before the bridged gap child', () => {
    const conversation = {
      messages: [
        {
          type: 'user',
          uuid: 'u-old',
          message: { parts: [{ text: 'old turn' } as Part] },
        },
        {
          type: 'user',
          uuid: 'u-new',
          message: { parts: [{ text: 'new turn' } as Part] },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
      historyGaps: [
        {
          childUuid: 'u-new',
          missingParentUuid: 'gone',
          bridgedToUuid: 'u-old',
          approxLostMs: 3 * 86_400_000,
        },
      ],
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 1_000);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: 'user', text: 'old turn' });
    expect(items[1].type).toBe(MessageType.INFO);
    // Test locale has no translations loaded → t() returns the English source.
    expect((items[1] as { text: string }).text).toContain('History gap');
    expect((items[1] as { text: string }).text).toContain('3 day');
    expect(items[2]).toMatchObject({ type: 'user', text: 'new turn' });
  });

  it('uses non-recovered copy for a gap with no bridged island', () => {
    // childUuid is the first record; nothing was recovered above it, so the
    // notice must not claim recovered history is shown above.
    const conversation = {
      messages: [
        {
          type: 'user',
          uuid: 'b1',
          message: { parts: [{ text: 'first surviving turn' } as Part] },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
      historyGaps: [
        { childUuid: 'b1', missingParentUuid: 'gone', bridgedToUuid: null },
      ],
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 1_000);

    expect(items).toHaveLength(2);
    expect(items[0].type).toBe(MessageType.INFO);
    const text = (items[0] as { text: string }).text;
    expect(text).toContain('could not be recovered');
    expect(text).not.toContain('shown above');
    expect(items[1]).toMatchObject({
      type: 'user',
      text: 'first surviving turn',
    });
  });

  it('converts conversation into history items with incremental ids', () => {
    const conversation = {
      messages: [
        {
          type: 'user',
          message: { parts: [{ text: 'Hello' } as Part] },
        },
        {
          type: 'assistant',
          timestamp: '2026-01-15T14:30:00.000Z',
          message: {
            parts: [
              { text: 'Hi there' } as Part,
              {
                functionCall: {
                  id: 'call-1',
                  name: 'replace',
                  args: { old: 'a', new: 'b' },
                },
              } as unknown as Part,
            ],
          },
        },
        {
          type: 'tool_result',
          toolCallResult: {
            callId: 'call-1',
            resultDisplay: 'All set',
            status: 'success',
          },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const baseTimestamp = 1_000;
    const items = buildResumedHistoryItems(
      session,
      makeConfig({ replace: mockTool }),
      baseTimestamp,
    );

    expect(items).toEqual([
      { id: baseTimestamp + 1, type: 'user', text: 'Hello' },
      {
        id: baseTimestamp + 2,
        type: 'gemini',
        text: 'Hi there',
        timestamp: new Date('2026-01-15T14:30:00.000Z').getTime(),
      },
      {
        id: baseTimestamp + 3,
        type: 'tool_group',
        tools: [
          {
            callId: 'call-1',
            name: 'Replace',
            description: 'Mocked description',
            resultDisplay: 'All set',
            status: ToolCallStatus.Success,
            confirmationDetails: undefined,
          },
        ],
      },
    ]);
  });

  it('restores mid-turn user messages from display text', () => {
    const conversation = {
      messages: [
        {
          type: 'tool_result',
          toolCallResult: {
            callId: 'call-1',
            resultDisplay: 'All set',
            status: 'success',
          },
        },
        {
          type: 'user',
          subtype: 'mid_turn_user_message',
          message: {
            parts: [
              {
                text: '\n[User message received during tool execution]: save logs',
              } as Part,
            ],
          },
          systemPayload: { displayText: 'save logs' },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(
      session,
      makeConfig({ replace: mockTool }),
      20,
    );

    expect(items).toContainEqual({
      id: 21,
      type: 'notification',
      text: 'save logs',
    });
  });

  it('marks tool results as error, omits thought text, and falls back when tool is missing', () => {
    const conversation = {
      messages: [
        {
          type: 'assistant',
          timestamp: '2026-01-15T15:00:00.000Z',
          message: {
            parts: [
              {
                text: 'should be skipped',
                thought: { subject: 'hidden' },
              } as unknown as Part,
              { text: 'visible text' } as Part,
              {
                functionCall: {
                  id: 'missing-call',
                  name: 'unknown_tool',
                  args: { foo: 'bar' },
                },
              } as unknown as Part,
            ],
          },
        },
        {
          type: 'tool_result',
          toolCallResult: {
            callId: 'missing-call',
            resultDisplay: { summary: 'failure' },
            status: 'error',
          },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}));

    expect(items).toEqual([
      {
        id: expect.any(Number),
        type: 'gemini',
        text: 'visible text',
        timestamp: new Date('2026-01-15T15:00:00.000Z').getTime(),
      },
      {
        id: expect.any(Number),
        type: 'tool_group',
        tools: [
          {
            callId: 'missing-call',
            name: 'unknown_tool',
            description: '',
            resultDisplay: { summary: 'failure' },
            status: ToolCallStatus.Error,
            confirmationDetails: undefined,
          },
        ],
      },
    ]);
  });

  it('keeps thought text in standalone previews without config', () => {
    const conversation = {
      messages: [
        {
          type: 'assistant',
          timestamp: '2026-01-15T16:00:00.000Z',
          message: {
            parts: [
              {
                text: 'preview thought',
                thought: true,
              } as unknown as Part,
              { text: 'visible text' } as Part,
            ],
          },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, null);

    expect(items).toEqual([
      {
        id: expect.any(Number),
        type: 'gemini_thought',
        text: 'preview thought',
      },
      {
        id: expect.any(Number),
        type: 'gemini',
        text: 'visible text',
        timestamp: new Date('2026-01-15T16:00:00.000Z').getTime(),
      },
    ]);
  });

  it('flushes pending tool groups before subsequent user messages', () => {
    const conversation = {
      messages: [
        {
          type: 'assistant',
          message: {
            parts: [
              {
                functionCall: {
                  id: 'call-2',
                  name: 'replace',
                  args: { target: 'a' },
                },
              } as unknown as Part,
            ],
          },
        },
        {
          type: 'user',
          message: { parts: [{ text: 'next user message' } as Part] },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(
      session,
      makeConfig({ replace: mockTool }),
      10,
    );

    expect(items[0]).toEqual({
      id: 11,
      type: 'tool_group',
      tools: [
        {
          callId: 'call-2',
          name: 'Replace',
          description: 'Mocked description',
          resultDisplay: undefined,
          status: ToolCallStatus.Success,
          confirmationDetails: undefined,
        },
      ],
    });
    expect(items[1]).toEqual({
      id: 12,
      type: 'user',
      text: 'next user message',
    });
  });

  it('replays slash command history items (e.g., /about) on resume', () => {
    const conversation = {
      messages: [
        {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'invocation',
            rawCommand: '/about',
          },
        },
        {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'result',
            rawCommand: '/about',
            outputHistoryItems: [
              {
                type: 'about',
                systemInfo: {
                  cliVersion: '1.2.3',
                  osPlatform: 'darwin',
                  osArch: 'arm64',
                  osRelease: 'test',
                  nodeVersion: '20.x',
                  npmVersion: '10.x',
                  sandboxEnv: 'none',
                  modelVersion: 'qwen',
                  selectedAuthType: 'none',
                  ideClient: 'none',
                  sessionId: 'abc',
                  memoryUsage: '0 MB',
                },
              },
            ],
          },
        },
        {
          type: 'assistant',
          timestamp: '2026-01-15T17:00:00.000Z',
          message: { parts: [{ text: 'Follow-up' } as Part] },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 5);

    expect(items).toEqual([
      { id: 6, type: 'user', text: '/about' },
      {
        id: 7,
        type: 'about',
        systemInfo: expect.objectContaining({ cliVersion: '1.2.3' }),
      },
      {
        id: 8,
        type: 'gemini',
        text: 'Follow-up',
        timestamp: new Date('2026-01-15T17:00:00.000Z').getTime(),
      },
    ]);
  });

  it('preserves model-sent slash command metadata on resume', () => {
    const conversation = {
      messages: [
        {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'invocation',
            rawCommand: '/filecmd',
            sentToModel: true,
          },
        },
        {
          type: 'assistant',
          timestamp: '2026-01-15T18:00:00.000Z',
          message: { parts: [{ text: 'Follow-up' } as Part] },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 20);

    expect(items).toEqual([
      { id: 21, type: 'user', text: '/filecmd', sentToModel: true },
      {
        id: 22,
        type: 'gemini',
        text: 'Follow-up',
        timestamp: new Date('2026-01-15T18:00:00.000Z').getTime(),
      },
    ]);
  });

  it('preserves local-only slash command metadata on resume', () => {
    const conversation = {
      messages: [
        {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'invocation',
            rawCommand: '/about',
            sentToModel: false,
          },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 30);

    expect(items).toEqual([
      { id: 31, type: 'user', text: '/about', sentToModel: false },
    ]);
  });

  it('omits sentToModel for legacy slash command records', () => {
    const conversation = {
      messages: [
        {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'invocation',
            rawCommand: '/legacy',
          },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 40);

    expect(items).toEqual([{ id: 41, type: 'user', text: '/legacy' }]);
    expect(items[0]).not.toHaveProperty('sentToModel');
  });

  it('omits corrupted non-boolean sentToModel metadata on resume', () => {
    const conversation = {
      messages: [
        {
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            phase: 'invocation',
            rawCommand: '/filecmd',
            sentToModel: 'true',
          },
        },
      ],
    } as unknown as ConversationRecord;

    const session: ResumedSessionData = {
      conversation,
    } as ResumedSessionData;

    const items = buildResumedHistoryItems(session, makeConfig({}), 50);

    expect(items).toEqual([{ id: 51, type: 'user', text: '/filecmd' }]);
    expect(items[0]).not.toHaveProperty('sentToModel');
  });
});

describe('applyCollapsePolicyAndSummary', () => {
  const makeItems = (): HistoryItem[] =>
    [
      { id: 1, type: MessageType.USER, text: 'first' },
      { id: 2, type: MessageType.GEMINI, text: 'first response' },
      { id: 3, type: MessageType.USER, text: 'second' },
      { id: 4, type: MessageType.GEMINI, text: 'second response' },
      { id: 5, type: MessageType.USER, text: 'third' },
      { id: 6, type: MessageType.GEMINI, text: 'third response' },
    ] as HistoryItem[];

  const expectSuppressed = (item: HistoryItem) => {
    expect(item.display).toEqual(
      expect.objectContaining({ suppressOnRestore: true }),
    );
  };

  const expectVisible = (item: HistoryItem) => {
    expect(item.display?.suppressOnRestore).toBeUndefined();
  };

  it('suppresses all items and shows the full summary count by default', () => {
    const result = applyCollapsePolicyAndSummary(makeItems(), true);

    expect(result).toHaveLength(7);
    result.slice(0, 6).forEach(expectSuppressed);
    expect(result[6]).toEqual(
      expect.objectContaining({
        id: 7,
        type: MessageType.INFO,
        text: expect.stringContaining('6 messages hidden'),
        display: { kind: 'collapse-summary' },
      }),
    );
  });

  it('keeps the most recent N user turns visible and summarizes only hidden items', () => {
    const result = applyCollapsePolicyAndSummary(makeItems(), true, 2);

    expect(result).toHaveLength(7);
    result.slice(0, 2).forEach(expectSuppressed);
    result.slice(2, 6).forEach(expectVisible);
    expect(result[6]).toEqual(
      expect.objectContaining({
        id: 7,
        type: MessageType.INFO,
        text: expect.stringContaining('2 messages hidden'),
        display: { kind: 'collapse-summary' },
      }),
    );
  });

  it('shows all items without a summary when preview count covers all user turns', () => {
    const rawItems = makeItems();
    const result = applyCollapsePolicyAndSummary(rawItems, true, 3);

    expect(result).toEqual(rawItems);
    expect(
      result.some((item) => item.display?.kind === 'collapse-summary'),
    ).toBe(false);
    result.forEach(expectVisible);
  });

  it('shows all items without a summary when preview count is -1', () => {
    const rawItems = makeItems();
    const result = applyCollapsePolicyAndSummary(rawItems, true, -1);

    expect(result).toBe(rawItems);
  });

  it('returns raw items unchanged when collapseOnResume is false', () => {
    const rawItems = makeItems();
    const result = applyCollapsePolicyAndSummary(rawItems, false, 1);

    expect(result).toBe(rawItems);
  });

  it('returns empty history without a summary', () => {
    expect(applyCollapsePolicyAndSummary([], true)).toEqual([]);
  });
});

describe('stripSuppressOnRestore', () => {
  it('returns item unchanged when display is undefined', () => {
    const item = { id: 1, type: 'user', text: 'hello' } as HistoryItem;
    expect(stripSuppressOnRestore(item)).toBe(item);
  });

  it('returns item unchanged when suppressOnRestore is absent', () => {
    const item = {
      id: 1,
      type: 'user',
      text: 'hello',
      display: {},
    } as HistoryItem;
    const result = stripSuppressOnRestore(item);
    expect(result).toEqual({
      id: 1,
      type: 'user',
      text: 'hello',
      display: {},
    });
  });

  it('strips suppressOnRestore while preserving other display properties', () => {
    const item = {
      id: 1,
      type: 'user',
      text: 'hello',
      display: { suppressOnRestore: true, kind: 'collapse-summary' },
    } as HistoryItem;
    const result = stripSuppressOnRestore(item);
    expect(result).toEqual({
      id: 1,
      type: 'user',
      text: 'hello',
      display: { kind: 'collapse-summary' },
    });
  });

  it('sets display to undefined when suppressOnRestore was the only property', () => {
    const item = {
      id: 1,
      type: 'user',
      text: 'hello',
      display: { suppressOnRestore: true },
    } as HistoryItem;
    const result = stripSuppressOnRestore(item);
    expect(result).toEqual({
      id: 1,
      type: 'user',
      text: 'hello',
      display: undefined,
    });
  });
});

describe('expandCollapsedHistory', () => {
  it('returns empty array for empty input', () => {
    expect(expandCollapsedHistory([])).toEqual([]);
  });

  it('filters out collapse-summary items and strips suppressOnRestore', () => {
    const items = [
      {
        id: 1,
        type: 'user',
        text: 'hello',
        display: { suppressOnRestore: true },
      },
      {
        id: 2,
        type: 'gemini',
        text: 'hi',
        display: { suppressOnRestore: true },
      },
      {
        id: 3,
        type: 'info',
        text: 'Summary',
        display: { kind: 'collapse-summary' },
      },
    ] as HistoryItem[];
    const result = expandCollapsedHistory(items);
    expect(result).toEqual([
      { id: 1, type: 'user', text: 'hello', display: undefined },
      { id: 2, type: 'gemini', text: 'hi', display: undefined },
    ]);
  });

  it('preserves items without suppressOnRestore', () => {
    const items = [
      { id: 1, type: 'user', text: 'hello' },
      {
        id: 2,
        type: 'gemini',
        text: 'hi',
        display: { suppressOnRestore: true },
      },
    ] as HistoryItem[];
    const result = expandCollapsedHistory(items);
    expect(result).toEqual([
      { id: 1, type: 'user', text: 'hello' },
      { id: 2, type: 'gemini', text: 'hi', display: undefined },
    ]);
  });

  it('handles items with both suppressOnRestore and kind', () => {
    const items = [
      {
        id: 1,
        type: 'user',
        text: 'hello',
        display: { suppressOnRestore: true, kind: 'collapse-summary' },
      },
    ] as HistoryItem[];
    const result = expandCollapsedHistory(items);
    expect(result).toEqual([]);
  });
});
