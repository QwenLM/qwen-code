/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { useToolScheduler } from './useToolScheduler.js';
import {
  type Config,
  type ExecutingToolCall,
  InMemoryToolCallSnapshotStore,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolCallSnapshotStore,
  type ToolCall,
  ROOT_TOOL_CALL_SCOPE_ID,
  CoreToolCallStatus,
  type WaitingToolCall,
  READ_FILE_TOOL_NAME,
  type SubagentProgress,
} from '@qwen-code/core';

// Mock Core Scheduler
vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  class TestToolCallSnapshotStore {
    private readonly listeners = new Set<
      (snapshot: { toolCallScopeId: string; toolCalls: unknown[] }) => void
    >();

    publishToolCallSnapshot(snapshot: {
      toolCallScopeId: string;
      toolCalls: unknown[];
    }): void {
      for (const listener of this.listeners) {
        listener(snapshot);
      }
    }

    subscribeToolCallSnapshots(
      listener: (snapshot: {
        toolCallScopeId: string;
        toolCalls: unknown[];
      }) => void,
    ): () => void {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }

    clearToolCallSnapshotListeners(): void {
      this.listeners.clear();
    }
  }

  return {
    ...actual,
    InMemoryToolCallSnapshotStore: TestToolCallSnapshotStore,
  };
});

const createMockTool = (
  overrides: Partial<AnyDeclarativeTool> = {},
): AnyDeclarativeTool =>
  ({
    name: 'test_tool',
    displayName: 'Test Tool',
    description: 'A test tool',
    kind: 'function',
    parameterSchema: {},
    isOutputMarkdown: false,
    build: vi.fn(),
    ...overrides,
  }) as AnyDeclarativeTool;

const createMockInvocation = (
  overrides: Partial<AnyToolInvocation> = {},
): AnyToolInvocation =>
  ({
    getDescription: () => 'Executing test tool',
    execute: vi.fn(),
    params: {},
    toolLocations: [],
    ...overrides,
  }) as AnyToolInvocation;

describe('useToolScheduler', () => {
  let mockConfig: Config;
  let mockToolCallSnapshots: ToolCallSnapshotStore;

  beforeEach(() => {
    vi.clearAllMocks();
    mockToolCallSnapshots = new InMemoryToolCallSnapshotStore();
    mockConfig = {
      toolCallSnapshots: mockToolCallSnapshots,
    } as unknown as Config;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes with empty tool calls', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );
    const [toolCalls] = result.current;
    expect(toolCalls).toEqual([]);
  });

  it('updates tool calls when tool snapshot store publishes updates', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const mockToolCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-1',
        name: 'test_tool',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      liveOutput: 'Loading...',
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [mockToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    const [toolCalls] = result.current;
    expect(toolCalls).toHaveLength(1);
    // Expect Core Object structure, not Display Object
    expect(toolCalls[0]).toMatchObject({
      request: { callId: 'call-1', name: 'test_tool' },
      status: CoreToolCallStatus.Executing,
      liveOutput: 'Loading...',
      responseSubmittedToAssistant: false,
    });
  });

  it('preserves responseSubmittedToAssistant flag across updates', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const mockToolCall = {
      status: CoreToolCallStatus.Success as const,
      request: {
        callId: 'call-1',
        name: 'test',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      response: {
        callId: 'call-1',
        resultDisplay: 'OK',
        responseParts: [],
        error: undefined,
        errorType: undefined,
      },
    };

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [mockToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    act(() => {
      const [, markAsSubmitted] = result.current;
      markAsSubmitted(['call-1']);
    });

    expect(result.current[0][0].responseSubmittedToAssistant).toBe(true);

    // Verify flag is preserved across updates
    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [mockToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0][0].responseSubmittedToAssistant).toBe(true);
  });

  it('updates lastToolOutputTime when tools are executing', async () => {
    vi.useFakeTimers();
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const startTime = Date.now();
    vi.advanceTimersByTime(1000);

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [
          {
            status: CoreToolCallStatus.Executing as const,
            request: {
              callId: 'call-1',
              name: 'test',
              args: {},
              prompt_id: 'p1',
            },
            tool: createMockTool(),
            invocation: createMockInvocation(),
          },
        ],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    const [, , , , lastOutputTime] = result.current;
    expect(lastOutputTime).toBeGreaterThan(startTime);
    vi.useRealTimers();
  });

  it('ignores late updates for tool calls from a cancelled batch', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const runningToolCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-cancelled',
        name: 'test_tool',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [runningToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });
    expect(result.current[0]).toHaveLength(1);

    act(() => {
      const [, , setToolCallsForDisplay, cancelAll] = result.current;
      cancelAll(new AbortController().signal);
      setToolCallsForDisplay([]);
    });

    const lateCompletedToolCall = {
      ...runningToolCall,
      status: CoreToolCallStatus.Success as const,
      response: {
        callId: 'call-cancelled',
        resultDisplay: 'late success',
        responseParts: [],
        error: undefined,
        errorType: undefined,
      },
    };

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [lateCompletedToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0]).toEqual([]);
  });

  it('ignores late updates when cancelAll is called from a stale controller reference', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );
    const staleCancelAll = result.current[3];

    const runningToolCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-stale-cancel',
        name: 'test_tool',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [runningToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });
    expect(result.current[0]).toHaveLength(1);

    act(() => {
      staleCancelAll(new AbortController().signal);
      const [, , setToolCallsForDisplay] = result.current;
      setToolCallsForDisplay([]);
    });

    const lateCompletedToolCall = {
      ...runningToolCall,
      status: CoreToolCallStatus.Success as const,
      response: {
        callId: 'call-stale-cancel',
        resultDisplay: 'late success',
        responseParts: [],
        error: undefined,
        errorType: undefined,
      },
    };

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [lateCompletedToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0]).toEqual([]);
  });

  it('fences every late status for refusal-retired calls without blocking the next tool', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );
    const retiredCall = {
      status: CoreToolCallStatus.Executing,
      request: {
        callId: 'call-refused',
        name: 'test_tool',
        args: {},
        prompt_id: 'prompt-refused',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
    } as unknown as ToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [retiredCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });
    expect(result.current[0]).toHaveLength(1);

    act(() => {
      result.current[5](['call-refused']);
    });
    expect(result.current[0]).toEqual([]);

    const lateStatuses = [
      CoreToolCallStatus.Executing,
      CoreToolCallStatus.AwaitingApproval,
      CoreToolCallStatus.Success,
      CoreToolCallStatus.Error,
    ] as const;
    for (const status of lateStatuses) {
      act(() => {
        mockToolCallSnapshots.publishToolCallSnapshot({
          toolCalls: [
            {
              ...retiredCall,
              status,
              correlationId: 'call-refused',
              confirmationDetails: { type: 'info', title: 'Approve' },
              response: {
                callId: 'call-refused',
                responseParts: [],
                resultDisplay: `late ${status}`,
              },
            } as unknown as ToolCall,
          ],
          toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
        });
      });
      expect(result.current[0]).toEqual([]);
    }

    const nextCall = {
      ...retiredCall,
      request: {
        ...retiredCall.request,
        callId: 'call-next',
        prompt_id: 'prompt-continue',
      },
    } as unknown as ToolCall;
    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [nextCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0]).toHaveLength(1);
    expect(result.current[0][0].request.callId).toBe('call-next');
  });

  it('keeps cancelled root call ids when unrelated subagent updates arrive after cancel', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const rootAgentCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'root-agent-call',
        name: 'Agent',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool({ name: 'Agent', displayName: 'Agent' }),
      invocation: createMockInvocation(),
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [rootAgentCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });
    expect(result.current[0]).toHaveLength(1);

    act(() => {
      const [, , setToolCallsForDisplay, cancelAll] = result.current;
      cancelAll(new AbortController().signal);
      setToolCallsForDisplay([]);
    });

    const subagentToolCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'subagent-glob-call',
        name: 'Glob',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool({ name: 'Glob', displayName: 'Glob' }),
      invocation: createMockInvocation(),
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [subagentToolCall],
        toolCallScopeId: 'subagent-scheduler',
      });
    });

    const lateRootUpdate = {
      ...rootAgentCall,
      status: CoreToolCallStatus.Executing as const,
    };

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [lateRootUpdate],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0]).toEqual([]);
  });

  it('setToolCallsForDisplay re-groups tools by toolCallScopeId (Multi-Scheduler support)', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const callRoot = {
      status: CoreToolCallStatus.Success as const,
      request: {
        callId: 'call-root',
        name: 'test',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      response: {
        callId: 'call-root',
        responseParts: [],
        resultDisplay: 'OK',
        error: undefined,
        errorType: undefined,
      },
      toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
    };

    const callSub = {
      ...callRoot,
      request: { ...callRoot.request, callId: 'call-sub' },
      status: CoreToolCallStatus.AwaitingApproval as const, // Must be awaiting approval to be tracked
      toolCallScopeId: 'subagent-1',
      correlationId: 'corr-sub',
      confirmationDetails: { type: 'info', title: 'Confirm', prompt: 'Yes?' },
    } as WaitingToolCall & { toolCallScopeId: string };

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [callRoot],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });

      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [callSub],
        toolCallScopeId: 'subagent-1',
      });
    });

    const [toolCalls] = result.current;
    expect(toolCalls).toHaveLength(2);
    expect(
      toolCalls.find((t) => t.request.callId === 'call-root'),
    ).toBeDefined();
    expect(
      toolCalls.find((t) => t.request.callId === 'call-sub'),
    ).toBeDefined();

    act(() => {
      const [, , setToolCalls] = result.current;
      setToolCalls((prev) =>
        prev.map((t) => ({ ...t, responseSubmittedToAssistant: true })),
      );
    });

    const [toolCalls2] = result.current;
    expect(toolCalls2).toHaveLength(2);
    expect(toolCalls2.every((t) => t.responseSubmittedToAssistant)).toBe(true);
  });

  it('ignores tool snapshots from non-root schedulers when no tools await approval', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const subagentCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-sub',
        name: 'test',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      toolCallScopeId: 'subagent-1',
    };

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [subagentCall],
        toolCallScopeId: 'subagent-1',
      });
    });

    expect(result.current[0]).toHaveLength(0);
  });

  it('allows tool snapshots from non-root schedulers when tools are awaiting approval', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const subagentCall = {
      status: CoreToolCallStatus.AwaitingApproval as const,
      request: {
        callId: 'call-sub',
        name: 'test',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      toolCallScopeId: 'subagent-1',
      confirmationDetails: { type: 'info', title: 'Confirm', prompt: 'Yes?' },
    } as WaitingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [subagentCall],
        toolCallScopeId: 'subagent-1',
      });
    });

    const [toolCalls] = result.current;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].request.callId).toBe('call-sub');
    expect(toolCalls[0].status).toBe(CoreToolCallStatus.AwaitingApproval);
  });

  it('preserves subagent tools in the UI after they have been approved', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const subagentCall = {
      status: CoreToolCallStatus.AwaitingApproval as const,
      request: {
        callId: 'call-sub',
        name: 'test',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      toolCallScopeId: 'subagent-1',
      confirmationDetails: { type: 'info', title: 'Confirm', prompt: 'Yes?' },
    } as WaitingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [subagentCall],
        toolCallScopeId: 'subagent-1',
      });
    });

    expect(result.current[0]).toHaveLength(1);

    const approvedCall = {
      ...subagentCall,
      status: CoreToolCallStatus.Executing as const,
    } as unknown as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [approvedCall],
        toolCallScopeId: 'subagent-1',
      });
    });

    expect(result.current[0]).toHaveLength(1);
    expect(result.current[0][0].status).toBe(CoreToolCallStatus.Executing);

    // Background tool should not be shown
    const backgroundTool = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-background',
        name: READ_FILE_TOOL_NAME,
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool(),
      invocation: createMockInvocation(),
      toolCallScopeId: 'subagent-1',
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [backgroundTool],
        toolCallScopeId: 'subagent-1',
      });
    });

    // The subagent list should now be empty because the previously approved tool
    // is gone from the current list, and the new tool doesn't need approval.
    expect(result.current[0]).toHaveLength(0);
  });

  it('keeps subagent progress on Agent tool live output', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const progress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'research',
      recentActivity: [
        {
          id: '1',
          type: 'thought',
          content: 'Thinking...',
          status: 'running',
        },
      ],
      state: 'running',
    };

    const mockToolCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-1',
        name: 'research',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool({ name: 'research' }),
      invocation: createMockInvocation(),
      liveOutput: progress,
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [mockToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0]).toHaveLength(1);
    expect((result.current[0][0] as ExecutingToolCall).liveOutput).toBe(
      progress,
    );
  });

  it('replaces subagent progress when the same Agent tool publishes a new snapshot', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const firstProgress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'research',
      recentActivity: [
        {
          id: '1',
          type: 'thought',
          content: 'Thinking...',
          status: 'running',
        },
      ],
      state: 'running',
    };

    const mockToolCall = {
      status: CoreToolCallStatus.Executing as const,
      request: {
        callId: 'call-1',
        name: 'research',
        args: {},
        prompt_id: 'p1',
      },
      tool: createMockTool({ name: 'research' }),
      invocation: createMockInvocation(),
      liveOutput: firstProgress,
    } as ExecutingToolCall;

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [mockToolCall],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect((result.current[0][0] as ExecutingToolCall).liveOutput).toBe(
      firstProgress,
    );

    const secondProgress: SubagentProgress = {
      ...firstProgress,
      recentActivity: [
        {
          id: '1',
          type: 'thought',
          content: 'Thinking... Done!',
          status: 'completed',
        },
      ],
    };
    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls: [{ ...mockToolCall, liveOutput: secondProgress }],
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    const liveOutput = (result.current[0][0] as ExecutingToolCall)
      .liveOutput as SubagentProgress;
    expect(liveOutput.recentActivity).toHaveLength(1);
    expect(liveOutput.recentActivity[0].content).toBe('Thinking... Done!');
    expect(liveOutput.recentActivity[0].status).toBe('completed');
  });

  it('keeps same-name Agent progress isolated by tool call snapshot', async () => {
    const { result } = await renderHook(() =>
      useToolScheduler(
        vi.fn().mockResolvedValue(undefined),
        mockConfig,
        () => undefined,
      ),
    );

    const firstProgress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'research',
      recentActivity: [],
      state: 'running',
    };
    const secondProgress: SubagentProgress = {
      isSubagentProgress: true,
      agentName: 'research',
      recentActivity: [
        {
          id: 'activity-2',
          type: 'thought',
          content: 'Second call only',
          status: 'running',
        },
      ],
      state: 'running',
    };

    const toolCalls = [
      {
        status: CoreToolCallStatus.Executing as const,
        request: {
          callId: 'call-1',
          name: 'invoke_subagent',
          args: { subagent_name: 'research' },
          prompt_id: 'p1',
        },
        tool: createMockTool({ name: 'invoke_subagent' }),
        invocation: createMockInvocation(),
        liveOutput: firstProgress,
      },
      {
        status: CoreToolCallStatus.Executing as const,
        request: {
          callId: 'call-2',
          name: 'invoke_subagent',
          args: { subagent_name: 'research' },
          prompt_id: 'p2',
        },
        tool: createMockTool({ name: 'invoke_subagent' }),
        invocation: createMockInvocation(),
        liveOutput: secondProgress,
      },
    ] as ExecutingToolCall[];

    act(() => {
      mockToolCallSnapshots.publishToolCallSnapshot({
        toolCalls,
        toolCallScopeId: ROOT_TOOL_CALL_SCOPE_ID,
      });
    });

    expect(result.current[0][0].request.callId).toBe('call-1');
    expect((result.current[0][0] as ExecutingToolCall).liveOutput).toBe(
      firstProgress,
    );
    expect(result.current[0][1].request.callId).toBe('call-2');
    const liveOutput = (result.current[0][1] as ExecutingToolCall)
      .liveOutput as SubagentProgress;
    expect(liveOutput.recentActivity).toHaveLength(1);
    expect(liveOutput.recentActivity[0].content).toBe('Second call only');
  });
});
