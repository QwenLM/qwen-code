/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CoreToolCallStatus,
  Kind,
  type AnyDeclarativeTool,
  type ModelStreamEvent,
  type Config,
  type ExecutingToolCall,
  type SubagentProgress,
  type SuccessfulToolCall,
} from '@qwen-code/core';
import { renderHook } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { createMockSettings } from '../../test-utils/settings.js';
import { useRuntimeProjection } from './useRuntimeProjection.js';
import { useToolScheduler } from './useToolScheduler.js';
import {
  MessageType,
  StreamingState,
  type HistoryItemToolGroup,
} from '../types.js';

vi.mock('./useToolScheduler.js', () => ({
  useToolScheduler: vi.fn(),
}));

const mockedUseToolScheduler = vi.mocked(useToolScheduler);

function createAgentTool(): AnyDeclarativeTool {
  return {
    name: 'invoke_subagent',
    displayName: 'Agent',
    description: 'Run a subagent',
    kind: Kind.Agent,
    parameterSchema: {},
    isOutputMarkdown: false,
    build: vi.fn(),
  } as unknown as AnyDeclarativeTool;
}

function createExecuteTool(): AnyDeclarativeTool {
  return {
    name: 'shell',
    displayName: 'Shell',
    description: 'Run a shell command',
    kind: Kind.Execute,
    parameterSchema: {},
    isOutputMarkdown: false,
    build: vi.fn(),
  } as unknown as AnyDeclarativeTool;
}

function createTaskTool(): AnyDeclarativeTool {
  return {
    name: 'TaskCreate',
    displayName: 'Create Task',
    description: 'Create a persistent task',
    kind: Kind.Edit,
    parameterSchema: {},
    isOutputMarkdown: false,
    build: vi.fn(),
  } as unknown as AnyDeclarativeTool;
}

function createRunningTaskCall(callId: string): ExecutingToolCall {
  return {
    status: CoreToolCallStatus.Executing,
    request: {
      callId,
      name: 'TaskCreate',
      args: {
        subject: 'Implement the task module',
        description: 'Implement and test the persistent task module.',
      },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    tool: createTaskTool(),
    invocation: {
      getDescription: () => 'Implement the task module',
      execute: vi.fn(),
      params: {},
      toolLocations: [],
    },
  } as unknown as ExecutingToolCall;
}

function createRunningExecuteCall(callId: string): ExecutingToolCall {
  return {
    status: CoreToolCallStatus.Executing,
    request: {
      callId,
      name: 'shell',
      args: { command: 'npm test' },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    tool: createExecuteTool(),
    invocation: {
      getDescription: () => 'npm test',
      execute: vi.fn(),
      params: {},
      toolLocations: [],
    },
  } as unknown as ExecutingToolCall;
}

function createSuccessfulExecuteCall(callId: string): SuccessfulToolCall {
  return {
    status: CoreToolCallStatus.Success,
    request: {
      callId,
      name: 'shell',
      args: { command: 'echo done' },
      isClientInitiated: false,
      prompt_id: 'prompt-1',
    },
    tool: createExecuteTool(),
    invocation: {
      getDescription: () => 'echo done',
      execute: vi.fn(),
      params: {},
      toolLocations: [],
    },
    response: {
      callId,
      responseParts: [{ text: 'done' }],
      resultDisplay: 'done',
      error: undefined,
      errorType: undefined,
    },
  } as unknown as SuccessfulToolCall;
}

describe('useRuntimeProjection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not append duplicate cancellation notices when cancelTurn is called twice', async () => {
    const addItem = vi.fn();
    const setToolCallsForDisplay = vi.fn();

    mockedUseToolScheduler.mockReturnValue([
      [],
      vi.fn(),
      setToolCallsForDisplay,
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );

    act(() => {
      result.current.controller.cancelTurn();
      result.current.controller.cancelTurn();
    });

    expect(addItem).toHaveBeenCalledTimes(1);
    expect(addItem).toHaveBeenCalledWith({
      type: MessageType.INFO,
      text: 'Request cancelled.',
    });
  });

  it('keeps running subagent tool calls as cancelled history items when the turn is cancelled', async () => {
    const addItem = vi.fn();
    const setToolCallsForDisplay = vi.fn();
    const runningAgentCall = {
      status: CoreToolCallStatus.Executing,
      request: {
        callId: 'agent-call-1',
        name: 'invoke_subagent',
        args: { subagent_name: 'researcher' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      tool: createAgentTool(),
      invocation: {
        getDescription: () => 'Running subagent',
        execute: vi.fn(),
        params: {},
        toolLocations: [],
      },
    } as unknown as ExecutingToolCall;

    mockedUseToolScheduler.mockReturnValue([
      [runningAgentCall],
      vi.fn(),
      setToolCallsForDisplay,
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );

    act(() => {
      result.current.controller.cancelTurn();
    });

    expect(setToolCallsForDisplay).toHaveBeenCalledWith([]);
    expect(addItem).toHaveBeenCalledTimes(1);
    const item = addItem.mock.calls[0]?.[0] as HistoryItemToolGroup;
    expect(item.type).toBe('tool_group');
    expect(item.tools).toHaveLength(1);
    expect(item.tools[0].status).toBe(CoreToolCallStatus.Error);
    expect(item.tools[0].resultDisplay).toMatchObject({
      isSubagentProgress: true,
      agentName: 'researcher',
      state: 'cancelled',
      result: 'User cancelled.',
    });
  });

  it('preserves completed subagent live output in cancelled history items', async () => {
    const addItem = vi.fn();
    const setToolCallsForDisplay = vi.fn();
    const completedProgress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'Explore',
      state: 'completed',
      result: 'finished before parent cancellation',
      recentActivity: [
        {
          id: 'read-done',
          type: 'tool_call',
          status: 'completed',
          content: 'Read',
          displayName: 'Read',
          args: '{"file_path":"package.json"}',
          toolResult: {
            content: '',
            isError: false,
          },
        },
      ],
    };
    const runningAgentCall = {
      status: CoreToolCallStatus.Executing,
      request: {
        callId: 'agent-call-completed-before-cancel',
        name: 'invoke_subagent',
        args: { subagent_name: 'Explore' },
        isClientInitiated: false,
        prompt_id: 'prompt-1',
      },
      tool: createAgentTool(),
      invocation: {
        getDescription: () => 'Completed subagent',
        execute: vi.fn(),
        params: {},
        toolLocations: [],
      },
      liveOutput: completedProgress,
    } as unknown as ExecutingToolCall;

    mockedUseToolScheduler.mockReturnValue([
      [runningAgentCall],
      vi.fn(),
      setToolCallsForDisplay,
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );

    act(() => {
      result.current.controller.cancelTurn();
    });

    const item = addItem.mock.calls[0]?.[0] as HistoryItemToolGroup;
    expect(item.tools[0].status).toBe(CoreToolCallStatus.Error);
    expect(item.tools[0].resultDisplay).toMatchObject({
      isSubagentProgress: true,
      agentName: 'Explore',
      state: 'completed',
      result: 'finished before parent cancellation',
    });
  });

  it('keeps running non-agent tools as plain cancelled history items', async () => {
    const addItem = vi.fn();
    const setToolCallsForDisplay = vi.fn();
    const runningToolCall = createRunningExecuteCall('shell-call-1');

    mockedUseToolScheduler.mockReturnValue([
      [runningToolCall],
      vi.fn(),
      setToolCallsForDisplay,
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );

    act(() => {
      result.current.controller.cancelTurn();
    });

    const item = addItem.mock.calls[0]?.[0] as HistoryItemToolGroup;
    expect(item.tools[0].status).toBe(CoreToolCallStatus.Cancelled);
    expect(item.tools[0].resultDisplay).toBe('User cancelled.');
  });

  it('does not write already-pushed tool calls again when the turn is cancelled', async () => {
    const addItem = vi.fn();
    const setToolCallsForDisplay = vi.fn();
    const completedToolCall = createSuccessfulExecuteCall('shell-call-done');
    const runningToolCall = createRunningExecuteCall('shell-call-running');

    mockedUseToolScheduler.mockReturnValue([
      [completedToolCall, runningToolCall],
      vi.fn(),
      setToolCallsForDisplay,
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );

    await waitFor(() => {
      expect(addItem).toHaveBeenCalledTimes(1);
    });
    const completedItem = addItem.mock.calls[0]?.[0] as HistoryItemToolGroup;
    expect(completedItem.tools.map((tool) => tool.callId)).toEqual([
      'shell-call-done',
    ]);

    act(() => {
      result.current.controller.cancelTurn();
    });

    expect(addItem).toHaveBeenCalledTimes(2);
    const cancelledItem = addItem.mock.calls[1]?.[0] as HistoryItemToolGroup;
    expect(cancelledItem.tools.map((tool) => tool.callId)).toEqual([
      'shell-call-running',
    ]);
    expect(cancelledItem.tools[0].status).toBe(CoreToolCallStatus.Cancelled);
  });

  it('keeps the projected streaming state idle after cancellation even if a late tool update arrives', async () => {
    const addItem = vi.fn();
    const setToolCallsForDisplay = vi.fn();
    let toolCalls = [createRunningExecuteCall('shell-call-running')];

    mockedUseToolScheduler.mockImplementation(() => [
      toolCalls,
      vi.fn(),
      setToolCallsForDisplay,
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result, rerender } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );

    expect(result.current.streamingState).toBe(StreamingState.Responding);

    act(() => {
      result.current.controller.cancelTurn();
    });

    toolCalls = [createRunningExecuteCall('shell-call-late')];
    rerender();

    expect(result.current.streamingState).toBe(StreamingState.Idle);
    expect(result.current.controller.getStreamingState()).toBe(
      StreamingState.Idle,
    );
  });

  it('keeps model turn ownership while tools execute between requests', async () => {
    mockedUseToolScheduler.mockReturnValue([
      [createRunningExecuteCall('shell-call-running')],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem: vi.fn(),
        getPreferredEditor: () => undefined,
      }),
    );

    expect(result.current.streamingState).toBe(StreamingState.Responding);
    expect(result.current.isModelTurnActive).toBe(false);
    const initialSnapshot = result.current.controller.getSnapshot();
    expect(initialSnapshot.pendingHistoryItems).toBe(
      result.current.pendingHistoryItems,
    );
    expect(initialSnapshot.isModelTurnActive).toBe(false);

    act(() => {
      result.current.controller.startTurn();
    });
    expect(result.current.isModelTurnActive).toBe(false);

    act(() => {
      result.current.controller.handleRequestStart();
    });
    expect(result.current.isModelTurnActive).toBe(true);
    expect(result.current.controller.getSnapshot().isModelTurnActive).toBe(
      true,
    );
    expect(initialSnapshot.isModelTurnActive).toBe(false);

    act(() => {
      result.current.controller.handleStreamEvent({ type: 'message_stop' });
    });
    expect(result.current.isModelTurnActive).toBe(true);
    expect(result.current.streamingState).toBe(StreamingState.Responding);

    act(() => {
      result.current.controller.handleRequestStart();
      result.current.controller.finishTurn();
    });
    expect(result.current.isModelTurnActive).toBe(false);

    act(() => {
      result.current.controller.startTurn();
      result.current.controller.handleRequestStart();
      result.current.controller.cancelTurn();
    });
    expect(result.current.isModelTurnActive).toBe(false);
    expect(result.current.controller.getSnapshot().isModelTurnActive).toBe(
      false,
    );
  });

  it('uses input resolution to expose model ownership before request_start', async () => {
    mockedUseToolScheduler.mockReturnValue([
      [],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem: vi.fn(),
        getPreferredEditor: () => undefined,
      }),
    );

    act(() => {
      result.current.controller.startTurn({ modelTurnActive: true });
    });
    expect(result.current.streamingState).toBe(StreamingState.Responding);
    expect(result.current.isModelTurnActive).toBe(true);

    act(() => {
      result.current.controller.handleInputResolved(false);
    });
    expect(result.current.isModelTurnActive).toBe(false);

    act(() => {
      result.current.controller.handleInputResolved(true);
    });
    expect(result.current.isModelTurnActive).toBe(true);
  });

  it('projects active reasoning only until assistant text starts', async () => {
    mockedUseToolScheduler.mockReturnValue([
      [],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem: vi.fn(),
        getPreferredEditor: () => undefined,
      }),
    );

    act(() => {
      result.current.controller.startTurn();
      result.current.controller.handleRequestStart();
    });
    expect(result.current.thought).toBeNull();

    act(() => {
      result.current.controller.handleStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Inspecting the workspace',
        },
      });
    });
    expect(result.current.thought).toEqual({
      subject: '',
      description: 'Inspecting the workspace',
    });

    act(() => {
      result.current.controller.handleRequestStart();
    });
    expect(result.current.thought).toBeNull();

    act(() => {
      result.current.controller.handleStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Preparing the response',
        },
      });
    });
    expect(result.current.thought).toEqual({
      subject: '',
      description: 'Preparing the response',
    });

    act(() => {
      result.current.controller.handleStreamEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Done' },
      });
    });
    expect(result.current.thought).toBeNull();
  });

  describe('stream delta batching', () => {
    const textDelta = (text: string): ModelStreamEvent => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    });
    const thinkingDelta = (thinking: string): ModelStreamEvent => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    });
    // Must match FRAME_INTERVAL_MS / 2 in useRuntimeProjection.ts.
    const WINDOW_MS = 16;

    async function setup(toolCalls: ExecutingToolCall[] = []) {
      const addItem = vi.fn();
      mockedUseToolScheduler.mockReturnValue([
        toolCalls,
        vi.fn(),
        vi.fn(),
        vi.fn(),
        0,
        vi.fn(),
      ]);
      const rendered = await renderHook(() =>
        useRuntimeProjection({
          config: {} as Config,
          settings: createMockSettings(),
          addItem,
          getPreferredEditor: () => undefined,
        }),
      );
      // Fake timers go on after mount: renderHook itself must run on real
      // timers, while the batcher resolves Date.now/setTimeout late. Only
      // the primitives the batcher uses are faked — faking setImmediate or
      // queueMicrotask would hijack React's scheduler and produce spurious
      // act() warnings.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      act(() => {
        rendered.result.current.controller.startTurn();
        rendered.result.current.controller.handleRequestStart();
      });
      return { ...rendered, addItem };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it('coalesces same-window text deltas into one update and flushes on the trailing edge', async () => {
      const { result } = await setup();

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('Hello'));
      });
      expect(result.current.pendingHistoryItems[0]).toMatchObject({
        type: 'gemini',
        text: 'Hello',
      });

      act(() => {
        result.current.controller.handleStreamEvent(textDelta(' wor'));
        result.current.controller.handleStreamEvent(textDelta('ld'));
      });
      // Buffered: still the leading-edge text.
      expect(result.current.pendingHistoryItems[0]).toMatchObject({
        text: 'Hello',
      });

      act(() => {
        vi.advanceTimersByTime(WINDOW_MS);
      });
      expect(result.current.pendingHistoryItems[0]).toMatchObject({
        text: 'Hello world',
      });
    });

    it('keeps kind transitions synchronous and does not leak stale thinking across a text block', async () => {
      const { result, addItem } = await setup();

      act(() => {
        result.current.controller.handleStreamEvent(
          thinkingDelta('**A**\nstale'),
        );
      });
      expect(result.current.thought).toEqual({
        subject: 'A',
        description: 'stale',
      });

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('ok'));
      });
      // Text start clears the thought synchronously (kind-switch bypass).
      expect(result.current.thought).toBeNull();
      expect(result.current.pendingHistoryItems[0]).toMatchObject({
        type: 'gemini',
        text: 'ok',
      });

      act(() => {
        result.current.controller.handleStreamEvent(
          thinkingDelta('**B**\nfresh'),
        );
      });
      // Accumulated thinking was reset by the text apply: no "A" residue.
      expect(result.current.thought).toEqual({
        subject: 'B',
        description: 'fresh',
      });
      expect(addItem).toHaveBeenCalledWith({ type: 'gemini', text: 'ok' });
    });

    it('flushes buffered deltas on assistant_block and cancels the trailing timer', async () => {
      const { result, addItem } = await setup();

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('Hello'));
        result.current.controller.handleStreamEvent(textDelta(' world'));
      });
      act(() => {
        result.current.controller.handleAssistantBlock(
          {
            messageId: 'text-message',
            model: 'test-model',
            blocks: [{ type: 'text', text: 'Hello world' }],
          },
          0,
        );
      });
      expect(addItem).toHaveBeenCalledWith({
        type: 'gemini',
        text: 'Hello world',
      });
      expect(result.current.pendingHistoryItems).toHaveLength(0);

      act(() => {
        vi.advanceTimersByTime(WINDOW_MS * 4);
      });
      // The trailing timer must not resurrect the pending item.
      expect(result.current.pendingHistoryItems).toHaveLength(0);
    });

    it('lands the buffered tail in history on cancelTurn and ignores post-cancel deltas', async () => {
      const { result, addItem } = await setup();

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('partial'));
        result.current.controller.handleStreamEvent(textDelta(' tail'));
      });
      act(() => {
        result.current.controller.cancelTurn();
      });
      expect(addItem).toHaveBeenCalledWith({
        type: 'gemini',
        text: 'partial tail',
      });

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('late'));
        vi.advanceTimersByTime(WINDOW_MS * 4);
      });
      expect(result.current.pendingHistoryItems).toHaveLength(0);
    });

    it.each(['assistant_block', 'assistant'] as const)(
      'keeps the cancellation notice last when a late %s arrives after long output',
      async (eventType) => {
        const { result, addItem, unmount } = await setup();
        const text = '归档师在城市中寻找失落的记忆。'.repeat(150);

        act(() => {
          result.current.controller.handleStreamEvent(
            thinkingDelta('构思一篇长篇科幻小说。'),
          );
          result.current.controller.handleStreamEvent(textDelta(text));
          result.current.controller.handleStreamEvent(textDelta('故事未完。'));
          result.current.controller.cancelTurn();
        });

        const historyAtCancellation = addItem.mock.calls.map(([item]) => item);
        expect(historyAtCancellation).toContainEqual(
          expect.objectContaining({ type: 'thinking' }),
        );
        expect(historyAtCancellation.slice(-2)).toEqual([
          { type: 'gemini', text: text + '故事未完。' },
          { type: MessageType.INFO, text: 'Request cancelled.' },
        ]);

        act(() => {
          const blocks = [{ type: 'text' as const, text: text + '故事未完。' }];
          if (eventType === 'assistant_block') {
            result.current.controller.handleAssistantBlock(
              { messageId: 'cancelled-message', model: 'test-model', blocks },
              0,
            );
          } else {
            result.current.controller.handleAssistantMessage({
              content: blocks,
            });
          }
          result.current.controller.handleStreamEvent(
            textDelta('迟到的增量。'),
          );
          result.current.controller.flushPendingToHistory();
          result.current.controller.finishTurn();
          vi.advanceTimersByTime(WINDOW_MS * 4);
        });

        expect(addItem.mock.calls.map(([item]) => item)).toEqual(
          historyAtCancellation,
        );
        expect(result.current.pendingHistoryItems).toHaveLength(0);
        expect(result.current.streamingState).toBe(StreamingState.Idle);

        act(() => {
          result.current.controller.startTurn();
          result.current.controller.handleRequestStart();
          result.current.controller.handleStreamEvent(
            textDelta('下一轮正常输出。'),
          );
          result.current.controller.handleAssistantBlock(
            {
              messageId: 'next-message',
              model: 'test-model',
              blocks: [{ type: 'text', text: '下一轮正常输出。' }],
            },
            0,
          );
          result.current.controller.handleAssistantMessage({
            content: [{ type: 'text', text: '下一轮正常输出。' }],
          });
        });

        expect(addItem.mock.calls.map(([item]) => item)).toEqual([
          ...historyAtCancellation,
          { type: 'gemini', text: '下一轮正常输出。' },
        ]);
        unmount();
      },
    );

    it.each(['before-output', 'thinking', 'committed-block'] as const)(
      'ignores late assistant output after cancellation during %s, including after finishTurn',
      async (phase) => {
        const { result, addItem, unmount } = await setup();
        act(() => {
          if (phase === 'thinking') {
            result.current.controller.handleStreamEvent(
              thinkingDelta('正在构思。'),
            );
          } else if (phase === 'committed-block') {
            result.current.controller.handleAssistantBlock(
              {
                messageId: 'committed-before-cancel',
                model: 'test-model',
                blocks: [{ type: 'text', text: '已经完成的一段。' }],
              },
              0,
            );
          }
          result.current.controller.cancelTurn();
          result.current.controller.cancelTurn();
          result.current.controller.finishTurn();
        });
        const historyAtCancellation = [...addItem.mock.calls];
        expect(
          historyAtCancellation.filter(
            ([item]) => item.text === 'Request cancelled.',
          ),
        ).toHaveLength(1);

        act(() => {
          result.current.controller.handleAssistantBlock(
            {
              messageId: 'late-block',
              model: 'test-model',
              blocks: [{ type: 'text', text: '取消后的正文。' }],
            },
            0,
          );
          result.current.controller.handleAssistantMessage({
            content: [{ type: 'text', text: '取消后的正文。' }],
          });
          result.current.controller.handleStreamEvent(
            thinkingDelta('迟到的思考。'),
          );
          result.current.controller.handleStreamEvent(
            textDelta('迟到的正文。'),
          );
          result.current.controller.flushPendingToHistory({
            skipEmptyAssistant: true,
          });
          vi.advanceTimersByTime(WINDOW_MS * 4);
        });

        expect(addItem.mock.calls).toEqual(historyAtCancellation);
        expect(result.current.pendingHistoryItems).toHaveLength(0);
        expect(result.current.thought).toBeNull();
        expect(result.current.lastTurnEnd).toBe('cancelled');
        expect(result.current.streamingState).toBe(StreamingState.Idle);
        unmount();
      },
    );

    it.each(['unstreamed', 'streamed', 'committed-block'] as const)(
      'preserves normal %s completion without duplicating text',
      async (mode) => {
        const { result, addItem, unmount } = await setup();
        act(() => {
          if (mode !== 'unstreamed') {
            result.current.controller.handleStreamEvent(textDelta('正常'));
            result.current.controller.handleStreamEvent(textDelta('回答。'));
          }
          if (mode === 'committed-block') {
            result.current.controller.handleAssistantBlock(
              {
                messageId: 'normal-message',
                model: 'test-model',
                blocks: [{ type: 'text', text: '正常回答。' }],
              },
              0,
            );
          }
          result.current.controller.handleAssistantMessage({
            content: [{ type: 'text', text: '正常回答。' }],
          });
          result.current.controller.flushPendingToHistory({
            skipEmptyAssistant: true,
          });
          result.current.controller.finishTurn();
          vi.advanceTimersByTime(WINDOW_MS * 4);
        });

        expect(addItem.mock.calls).toEqual([
          [{ type: 'gemini', text: '正常回答。' }],
        ]);
        expect(result.current.pendingHistoryItems).toHaveLength(0);
        expect(result.current.lastTurnEnd).toBe('completed');
        expect(result.current.streamingState).toBe(StreamingState.Idle);
        unmount();
      },
    );

    it('preserves a cancelled tool group when late assistant messages arrive', async () => {
      const { result, addItem, unmount } = await setup([
        createRunningExecuteCall('cancelled-shell'),
      ]);
      act(() => {
        result.current.controller.handleStreamEvent(
          textDelta('调用工具前的正文。'),
        );
        result.current.controller.cancelTurn();
      });
      const historyAtCancellation = [...addItem.mock.calls];
      expect(historyAtCancellation.map(([item]) => item.type)).toEqual([
        'gemini',
        'tool_group',
      ]);
      expect(historyAtCancellation[1][0].tools[0]).toMatchObject({
        callId: 'cancelled-shell',
        status: CoreToolCallStatus.Cancelled,
        resultDisplay: 'User cancelled.',
      });
      act(() => {
        result.current.controller.handleAssistantBlock(
          {
            messageId: 'cancelled-tool-message',
            model: 'test-model',
            blocks: [{ type: 'text', text: '调用工具前的正文。' }],
          },
          0,
        );
        result.current.controller.handleAssistantMessage({
          content: [{ type: 'text', text: '调用工具前的正文。' }],
        });
        result.current.controller.finishTurn();
      });
      expect(addItem.mock.calls).toEqual(historyAtCancellation);
      expect(result.current.lastTurnEnd).toBe('cancelled');
      unmount();
    });

    it('gives the first delta after a request boundary the leading edge', async () => {
      const { result } = await setup();

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('first'));
      });
      // New request starts inside the same throttle window.
      act(() => {
        result.current.controller.handleRequestStart();
      });
      act(() => {
        result.current.controller.handleStreamEvent(textDelta('second'));
      });
      expect(result.current.pendingHistoryItems[0]).toMatchObject({
        type: 'gemini',
        text: 'second',
      });
    });

    it('discards buffered deltas on finishTurn and leaves no timer on unmount', async () => {
      const { result, unmount, addItem } = await setup();

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('shown'));
        result.current.controller.handleStreamEvent(textDelta(' dropped'));
      });
      act(() => {
        result.current.controller.flushPendingToHistory();
        result.current.controller.finishTurn();
      });
      // flushPendingToHistory drained the buffer into history first.
      expect(addItem).toHaveBeenCalledWith({
        type: 'gemini',
        text: 'shown dropped',
      });

      act(() => {
        result.current.controller.handleStreamEvent(textDelta('a'));
        result.current.controller.handleStreamEvent(textDelta('b'));
      });
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('does not project an empty closing border for a running task tool', async () => {
    mockedUseToolScheduler.mockReturnValue([
      [createRunningTaskCall('task-create-running')],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      0,
      vi.fn(),
    ]);

    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem: vi.fn(),
        getPreferredEditor: () => undefined,
      }),
    );

    expect(result.current.pendingHistoryItems).not.toContainEqual(
      expect.objectContaining({
        type: 'tool_group',
        tools: [],
        borderBottom: true,
      }),
    );
  });

  it('renders a durable unknown tool result once and keeps it after the turn finishes', async () => {
    const addItem = vi.fn();
    const retireToolCalls = vi.fn();
    mockedUseToolScheduler.mockReturnValue([
      [],
      vi.fn(),
      vi.fn(),
      vi.fn(),
      0,
      retireToolCalls,
    ]);
    const { result } = await renderHook(() =>
      useRuntimeProjection({
        config: {} as Config,
        settings: createMockSettings(),
        addItem,
        getPreferredEditor: () => undefined,
      }),
    );
    const unknownDisplay = {
      summary: 'Tool execution status unknown',
      payload:
        'The model response ended in refusal before the tool result could be confirmed. ' +
        'The tool may not have run, may have partially completed, or may have completed. ' +
        'Inspect the current state before retrying or continuing.',
    };

    act(() => {
      result.current.controller.startTurn();
      result.current.controller.handleAssistantBlock(
        {
          messageId: 'refused-message',
          model: 'test-model',
          blocks: [
            {
              type: 'tool_use',
              id: 'tool-refused',
              name: 'shell',
              input: { command: 'deploy' },
            },
          ],
        },
        0,
      );
      const durableResult = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-refused',
              content: 'model-only recovery guidance',
              is_error: true,
            },
          ],
        },
        toolUseResult: unknownDisplay,
      } as never;
      result.current.controller.handleToolResultMessage(durableResult);
      result.current.controller.handleToolResultMessage(durableResult);
      result.current.controller.finishTurn();
    });

    expect(addItem).toHaveBeenCalledTimes(1);
    const item = addItem.mock.calls[0]?.[0] as HistoryItemToolGroup;
    expect(item.type).toBe('tool_group');
    expect(item.tools).toHaveLength(1);
    expect(item.tools[0]).toMatchObject({
      callId: 'tool-refused',
      status: CoreToolCallStatus.Error,
      resultDisplay: unknownDisplay,
    });
    expect(retireToolCalls).toHaveBeenCalledExactlyOnceWith(['tool-refused']);
  });
});
