/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildResumedHistoryItems } from './resumeHistoryUtils.js';
import { ToolCallStatus } from '../types.js';
import type {
  AnyDeclarativeTool,
  Config,
  ConversationRecord,
  ResumedSessionData,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';

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

  it('converts conversation into history items with incremental ids', () => {
    const conversation = {
      messages: [
        {
          type: 'user',
          message: { parts: [{ text: 'Hello' } as Part] },
        },
        {
          type: 'assistant',
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
      { id: baseTimestamp + 2, type: 'gemini', text: 'Hi there' },
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

  it('marks tool results as error, skips thought text, and falls back when tool is missing', () => {
    const conversation = {
      messages: [
        {
          type: 'assistant',
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
      { id: expect.any(Number), type: 'gemini', text: 'visible text' },
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
      { id: 8, type: 'gemini', text: 'Follow-up' },
    ]);
  });
});
