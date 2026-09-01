/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentResponse } from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { GoalTurnPermit } from '../goals/goal-protocol.js';
import type { ChatRecordingService } from '../services/chatRecordingService.js';
import { ToolNames } from '../tools/tool-names.js';
import type { ErroredToolCall } from './coreToolScheduler.js';
import { CoreToolScheduler } from './coreToolScheduler.js';
import { LlmChat, StreamEventType } from './llm-chat.js';
import { LlmEventType, Turn } from './turn.js';

const permit: GoalTurnPermit = {
  goalId: 'goal-1',
  revision: 1,
  turnId: 'turn-1',
};

describe('Goal turn evidence propagation', () => {
  it('forwards a defensive permit through Turn and attaches it to tool requests', async () => {
    const inputPermit: GoalTurnPermit = { ...permit };
    const sendMessageStream = vi.fn().mockResolvedValue(
      (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [
              { id: 'goal-tool-call', name: 'read_file', args: {} },
            ],
          } as unknown as GenerateContentResponse,
        };
      })(),
    );
    const turn = new Turn(
      { sendMessageStream } as unknown as LlmChat,
      'goal-prompt',
      inputPermit,
    );
    inputPermit.revision = 99;

    const events = [];
    for await (const event of turn.run(
      'test-model',
      [{ text: 'continue' }],
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(sendMessageStream).toHaveBeenCalledWith(
      'test-model',
      expect.any(Object),
      'goal-prompt',
      permit,
    );
    const toolRequest = events.find(
      (event) => event.type === LlmEventType.ToolCallRequest,
    );
    expect(toolRequest?.value).toMatchObject({
      callId: 'goal-tool-call',
      goalContext: permit,
    });
    expect(toolRequest?.value.goalContext).not.toBe(inputPermit);
  });

  it('attaches the permit to normal and deferred assistant attempts', async () => {
    const recordAssistantTurn = vi.fn();
    const chat = new LlmChat(
      {
        getContentGeneratorConfig: () => ({ contextWindowSize: 4096 }),
      } as unknown as Config,
      {},
      [],
      { recordAssistantTurn } as unknown as ChatRecordingService,
    );
    const internal = chat as unknown as {
      processStreamResponse: (
        model: string,
        stream: AsyncGenerator<GenerateContentResponse>,
        routeKey: string,
        goalContext?: GoalTurnPermit,
      ) => AsyncGenerator<GenerateContentResponse>;
      pendingPartialAssistantRecord:
        | Parameters<ChatRecordingService['recordAssistantTurn']>[0]
        | null;
    };
    const normalStream = (async function* () {
      yield {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'normal result' }] },
            finishReason: 'STOP',
          },
        ],
      } as GenerateContentResponse;
    })();

    for await (const _ of internal.processStreamResponse(
      'test-model',
      normalStream,
      'test-route',
      permit,
    )) {
      // Consume the persisted normal assistant attempt.
    }
    expect(recordAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({ goalContext: permit }),
    );

    const partialStream = (async function* () {
      yield {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'partial-goal-call',
                    name: 'read_file',
                    args: {},
                  },
                },
              ],
            },
          },
        ],
      } as GenerateContentResponse;
      throw new Error('partial stream failed');
    })();
    await expect(
      (async () => {
        for await (const _ of internal.processStreamResponse(
          'test-model',
          partialStream,
          'test-route',
          permit,
        )) {
          // Consume until the deferred partial attempt is staged.
        }
      })(),
    ).rejects.toThrow('partial stream failed');
    expect(internal.pendingPartialAssistantRecord).toMatchObject({
      goalContext: permit,
      message: [
        expect.objectContaining({
          functionCall: expect.objectContaining({ id: 'partial-goal-call' }),
        }),
      ],
    });
  });

  it('records Goal worker results as runtime evidence and other tools normally', () => {
    const recordToolResult = vi.fn();
    const scheduler = Object.create(CoreToolScheduler.prototype) as {
      chatRecordingService: { recordToolResult: typeof recordToolResult };
      recordToolResults(calls: ErroredToolCall[]): void;
    };
    scheduler.chatRecordingService = { recordToolResult };
    const completedCall = (name: string, callId: string): ErroredToolCall => ({
      status: 'error',
      request: {
        callId,
        name,
        args: {},
        isClientInitiated: false,
        prompt_id: 'recording-prompt',
        goalContext: { ...permit },
      },
      response: {
        callId,
        responseParts: [
          {
            functionResponse: {
              id: callId,
              name,
              response: { output: 'result' },
            },
          },
        ],
        resultDisplay: undefined,
        error: new Error('test'),
        errorType: undefined,
      },
    });

    scheduler.recordToolResults([
      completedCall('external_fact_tool', 'ordinary-call'),
    ]);
    scheduler.recordToolResults([
      completedCall(ToolNames.GET_GOAL, 'goal-control-call'),
    ]);

    expect(recordToolResult.mock.calls[0]?.[2]).toEqual({
      goalContext: permit,
    });
    expect(recordToolResult.mock.calls[1]?.[2]).toEqual({
      goalContext: permit,
      provenance: 'goal_runtime',
    });
  });
});
