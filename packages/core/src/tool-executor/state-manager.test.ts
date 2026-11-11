/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallStateManager } from './state-manager.js';
import {
  CoreToolCallStatus,
  ROOT_TOOL_CALL_SCOPE_ID,
  type ValidatingToolCall,
  type WaitingToolCall,
  type SuccessfulToolCall,
  type ErroredToolCall,
  type CancelledToolCall,
  type ExecutingToolCall,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
} from './types.js';
import {
  ToolConfirmationOutcome,
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type FileDiff,
} from '../tools/tools.js';
import type { ToolCallSnapshotPublisher } from './tool-call-snapshot.js';

describe('ToolCallStateManager', () => {
  const mockRequest: ToolCallRequestInfo = {
    callId: 'call-1',
    name: 'test-tool',
    args: { foo: 'bar' },
    prompt_id: 'prompt-1',
  };

  const mockTool = {
    name: 'test-tool',
    displayName: 'Test Tool',
  } as AnyDeclarativeTool;

  const mockInvocation = {
    execute: vi.fn(),
    getDescription: vi.fn(),
  } as unknown as AnyToolInvocation;

  const createValidatingCall = (
    id = 'call-1',
    planModeActive = false,
  ): ValidatingToolCall => ({
    status: CoreToolCallStatus.Validating,
    request: { ...mockRequest, callId: id },
    tool: mockTool,
    invocation: mockInvocation,
    startTime: Date.now(),
    planModeActive,
  });

  const createMockResponse = (id: string): ToolCallResponseInfo => ({
    callId: id,
    responseParts: [],
    resultDisplay: 'Success',
    error: undefined,
    errorType: undefined,
  });

  let stateManager: ToolCallStateManager;
  let mockToolCallSnapshots: ToolCallSnapshotPublisher;
  let onUpdate: (calls: unknown[]) => void;

  beforeEach(() => {
    onUpdate = vi.fn();
    mockToolCallSnapshots = {
      publishToolCallSnapshot: vi.fn((snapshot) => {
        onUpdate(snapshot.toolCalls);
      }),
    };

    stateManager = new ToolCallStateManager(mockToolCallSnapshots);
  });

  describe('Observer Callback', () => {
    it('should trigger onTerminalCall when finalizing a call', () => {
      const onTerminalCall = vi.fn();
      const manager = new ToolCallStateManager(
        mockToolCallSnapshots,
        ROOT_TOOL_CALL_SCOPE_ID,
        onTerminalCall,
      );
      const call = createValidatingCall();
      manager.addActiveCall(call);
      manager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Success,
        createMockResponse(call.request.callId),
      );
      manager.finalizeCall(call.request.callId);

      expect(onTerminalCall).toHaveBeenCalledTimes(1);
      expect(onTerminalCall).toHaveBeenCalledWith(
        expect.objectContaining({
          status: CoreToolCallStatus.Success,
          request: expect.objectContaining({ callId: call.request.callId }),
        }),
      );
    });

    it('finalizes the call when terminal and snapshot observers throw', () => {
      const publisher = {
        publishToolCallSnapshot: vi.fn(() => {
          throw new Error('snapshot observer failed');
        }),
      };
      const manager = new ToolCallStateManager(
        publisher,
        ROOT_TOOL_CALL_SCOPE_ID,
        () => {
          throw new Error('terminal observer failed');
        },
      );
      const call = createValidatingCall();

      expect(() => manager.addActiveCall(call)).not.toThrow();
      expect(() =>
        manager.updateStatus(
          call.request.callId,
          CoreToolCallStatus.Success,
          createMockResponse(call.request.callId),
        ),
      ).not.toThrow();
      expect(() => manager.finalizeCall(call.request.callId)).not.toThrow();

      expect(manager.isActive).toBe(false);
      expect(manager.completedBatch).toHaveLength(1);
    });
  });

  describe('Initialization', () => {
    it('should start with empty state', () => {
      expect(stateManager.isActive).toBe(false);
      expect(stateManager.activeCallCount).toBe(0);
      expect(stateManager.getSnapshot()).toEqual([]);
    });
  });

  describe('Lookup Operations', () => {
    it('should find tool calls in active calls', () => {
      const call = createValidatingCall('active-1');
      stateManager.addActiveCall(call);
      expect(stateManager.getToolCall('active-1')).toEqual(call);
    });

    it('should find tool calls in the completed batch', () => {
      const call = createValidatingCall('completed-1');
      stateManager.addActiveCall(call);
      stateManager.updateStatus(
        'completed-1',
        CoreToolCallStatus.Success,
        createMockResponse('completed-1'),
      );
      stateManager.finalizeCall('completed-1');
      expect(stateManager.getToolCall('completed-1')).toBeDefined();
    });

    it('should return undefined for non-existent callIds', () => {
      expect(stateManager.getToolCall('void')).toBeUndefined();
    });
  });

  describe('addActiveCall', () => {
    it('should add a call to active calls and notify', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      expect(stateManager.activeCallCount).toBe(1);
      expect(stateManager.isActive).toBe(true);
      expect(onUpdate).toHaveBeenCalledWith([call]);
    });

    it('should support adding multiple calls', () => {
      stateManager.addActiveCall(createValidatingCall('1'));
      stateManager.addActiveCall(createValidatingCall('2'));

      expect(stateManager.activeCallCount).toBe(2);
    });

    it('keeps submission order when a later call is finalized first', () => {
      stateManager.addActiveCall(createValidatingCall('slow-first'));
      stateManager.addActiveCall(createValidatingCall('fast-second'));

      stateManager.updateStatus(
        'fast-second',
        CoreToolCallStatus.Success,
        createMockResponse('fast-second'),
      );
      stateManager.finalizeCall('fast-second');

      expect(
        stateManager.getSnapshot().map((call) => call.request.callId),
      ).toEqual(['slow-first', 'fast-second']);
    });
  });

  describe('Status Transitions', () => {
    it('should transition validating to scheduled', () => {
      const call = createValidatingCall('call-1', false);
      stateManager.addActiveCall(call);

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Scheduled,
      );

      const snapshot = stateManager.getSnapshot();
      expect(snapshot[0].status).toBe(CoreToolCallStatus.Scheduled);
      expect(snapshot[0].request.callId).toBe(call.request.callId);
      expect(snapshot[0].planModeActive).toBe(false);
    });

    it('should transition scheduled to executing', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Scheduled,
      );

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
      );

      expect(stateManager.firstActiveCall?.status).toBe(
        CoreToolCallStatus.Executing,
      );
    });

    it('should transition to success and move to completed batch', () => {
      const call = createValidatingCall('call-1', false);
      stateManager.addActiveCall(call);

      const response: ToolCallResponseInfo = {
        callId: call.request.callId,
        responseParts: [],
        resultDisplay: 'Success',
        error: undefined,
        errorType: undefined,
      };

      vi.mocked(onUpdate).mockClear();
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Success,
        response,
      );
      expect(onUpdate).toHaveBeenCalledTimes(1);

      vi.mocked(onUpdate).mockClear();
      stateManager.finalizeCall(call.request.callId);
      expect(onUpdate).toHaveBeenCalledTimes(1);

      expect(stateManager.isActive).toBe(false);
      expect(stateManager.completedBatch).toHaveLength(1);
      const completed = stateManager.completedBatch[0] as SuccessfulToolCall;
      expect(completed.status).toBe(CoreToolCallStatus.Success);
      expect(completed.response).toEqual(response);
      expect(completed.durationMs).toBeDefined();
      expect(completed.planModeActive).toBe(false);
    });

    it('should transition to error and move to completed batch', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      const response: ToolCallResponseInfo = {
        callId: call.request.callId,
        responseParts: [],
        resultDisplay: 'Error',
        error: new Error('Failed'),
        errorType: undefined,
      };

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Error,
        response,
      );
      stateManager.finalizeCall(call.request.callId);

      expect(stateManager.isActive).toBe(false);
      expect(stateManager.completedBatch).toHaveLength(1);
      const completed = stateManager.completedBatch[0] as ErroredToolCall;
      expect(completed.status).toBe(CoreToolCallStatus.Error);
      expect(completed.response).toEqual(response);
    });

    it('should transition to awaiting_approval with details', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      const details = {
        type: 'info' as const,
        title: 'Confirm',
        prompt: 'Proceed?',
      };

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.AwaitingApproval,
        { correlationId: 'corr-1', confirmationDetails: details },
      );

      const active = stateManager.firstActiveCall as WaitingToolCall;
      expect(active.status).toBe(CoreToolCallStatus.AwaitingApproval);
      expect(active.confirmationDetails).toEqual(details);
    });

    it('should transition to awaiting_approval with event-driven format', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      const details = {
        type: 'info' as const,
        title: 'Confirm',
        prompt: 'Proceed?',
      };
      const eventDrivenData = {
        correlationId: 'corr-123',
        confirmationDetails: details,
      };

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.AwaitingApproval,
        eventDrivenData,
      );

      const active = stateManager.firstActiveCall as WaitingToolCall;
      expect(active.status).toBe(CoreToolCallStatus.AwaitingApproval);
      expect(active.correlationId).toBe('corr-123');
      expect(active.confirmationDetails).toEqual(details);
    });

    it('should preserve diff and derive stats when cancelling an edit tool call', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      const details = {
        type: 'edit' as const,
        title: 'Edit',
        fileName: 'test.txt',
        filePath: '/path/to/test.txt',
        fileDiff: '@@ -1,1 +1,1 @@\n-old line\n+new line',
        originalContent: 'old line',
        newContent: 'new line',
      };

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.AwaitingApproval,
        { correlationId: 'corr-edit', confirmationDetails: details },
      );
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Cancelled,
        'User said no',
      );
      stateManager.finalizeCall(call.request.callId);

      const completed = stateManager.completedBatch[0] as CancelledToolCall;
      expect(completed.status).toBe(CoreToolCallStatus.Cancelled);
      const result = completed.response.toolUseResult as FileDiff;
      expect(result.fileDiff).toBe(details.fileDiff);
      expect(result.diffStat).toEqual(
        expect.objectContaining({
          model_added_lines: 1,
          model_removed_lines: 1,
        }),
      );
    });

    it('should cancel a validating call that has no invocation yet', () => {
      const call: ValidatingToolCall = {
        status: CoreToolCallStatus.Validating,
        request: { ...mockRequest, callId: 'call-no-inv' },
        tool: mockTool,
        invocation: undefined as unknown as AnyToolInvocation,
        startTime: Date.now(),
        planModeActive: false,
      };
      stateManager.addActiveCall(call);

      // Should not throw even though invocation is undefined
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Cancelled,
        'User pressed Esc',
      );
      stateManager.finalizeCall(call.request.callId);

      expect(stateManager.completedBatch).toHaveLength(1);
      const completed = stateManager.completedBatch[0] as CancelledToolCall;
      expect(completed.status).toBe(CoreToolCallStatus.Cancelled);
      expect(completed.tool).toBe(mockTool);
      expect(completed.invocation).toBeUndefined();
      expect(completed.response.toolUseResult).toEqual({
        kind: 'tool-status',
        status: 'cancelled',
        summary: 'User cancelled.',
      });
    });

    it('should ignore status updates for non-existent callIds', () => {
      stateManager.updateStatus('unknown', CoreToolCallStatus.Scheduled);
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should ignore status updates for terminal calls', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Success,
        createMockResponse(call.request.callId),
      );
      stateManager.finalizeCall(call.request.callId);

      vi.mocked(onUpdate).mockClear();
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Scheduled,
      );
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('should only finalize terminal calls', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
      );
      stateManager.finalizeCall(call.request.callId);

      expect(stateManager.isActive).toBe(true);
      expect(stateManager.completedBatch).toHaveLength(0);

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Success,
        createMockResponse(call.request.callId),
      );
      stateManager.finalizeCall(call.request.callId);

      expect(stateManager.isActive).toBe(false);
      expect(stateManager.completedBatch).toHaveLength(1);
    });

    it('should merge liveOutput and pid during executing updates', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      // Start executing
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
      );
      let active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.status).toBe(CoreToolCallStatus.Executing);
      expect(active.liveOutput).toBeUndefined();
      expect(active.executionStartedAt).toEqual(expect.any(Number));
      const executionStartedAt = active.executionStartedAt;

      // Update with live output
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          liveOutput: 'chunk 1',
        },
      );
      active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.liveOutput).toBe('chunk 1');
      expect(active.executionStartedAt).toBe(executionStartedAt);

      // Update with pid (should preserve liveOutput)
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          pid: 1234,
        },
      );
      active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.liveOutput).toBe('chunk 1');
      expect(active.pid).toBe(1234);
      expect(active.executionStartedAt).toBe(executionStartedAt);

      // Update live output again (should preserve pid)
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          liveOutput: 'chunk 2',
        },
      );
      active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.liveOutput).toBe('chunk 2');
      expect(active.pid).toBe(1234);
    });

    it('should update progressMessage and progressPercent during executing updates', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      // Update with progress
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          progressMessage: 'Starting...',
          progressPercent: 10,
        },
      );
      let active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.progressMessage).toBe('Starting...');
      expect(active.progressPercent).toBe(10);

      // Update progress further
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          progressMessage: 'Halfway!',
          progressPercent: 50,
        },
      );
      active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.progressMessage).toBe('Halfway!');
      expect(active.progressPercent).toBe(50);
    });
  });

  describe('Argument Updates', () => {
    it('should update args and invocation', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      const newArgs = { foo: 'updated' };
      const newInvocation = { ...mockInvocation } as AnyToolInvocation;

      stateManager.updateArgs(call.request.callId, newArgs, newInvocation);

      const active = stateManager.firstActiveCall;
      if (active && 'invocation' in active) {
        expect(active.invocation).toEqual(newInvocation);
      } else {
        throw new Error('Active call should have invocation');
      }
    });

    it('should ignore arg updates for errored calls', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Error,
        createMockResponse(call.request.callId),
      );
      stateManager.finalizeCall(call.request.callId);

      stateManager.updateArgs(
        call.request.callId,
        { foo: 'new' },
        mockInvocation,
      );

      const completed = stateManager.completedBatch[0];
      expect(completed.request.args).toEqual(mockRequest.args);
    });
  });

  describe('Outcome Tracking', () => {
    it('should set outcome and notify', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);

      stateManager.setOutcome(
        call.request.callId,
        ToolConfirmationOutcome.ProceedSession,
      );

      const active = stateManager.firstActiveCall;
      expect(active?.outcome).toBe(ToolConfirmationOutcome.ProceedSession);
      expect(onUpdate).toHaveBeenCalled();
    });
  });

  describe('Batch Operations', () => {
    it('removes only retired call ids without creating terminal states', () => {
      const completed = createValidatingCall('completed-retired');
      stateManager.addActiveCall(completed);
      stateManager.updateStatus(
        completed.request.callId,
        CoreToolCallStatus.Success,
        createMockResponse(completed.request.callId),
      );
      stateManager.finalizeCall(completed.request.callId);
      stateManager.addActiveCall(createValidatingCall('active-retired'));
      stateManager.addActiveCall(createValidatingCall('active-kept'));
      vi.mocked(onUpdate).mockClear();

      stateManager.removeCalls(
        new Set(['completed-retired', 'active-retired']),
      );

      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(stateManager.completedBatch).toEqual([]);
      expect(
        stateManager.getSnapshot().map((call) => call.request.callId),
      ).toEqual(['active-kept']);
    });

    it('should clear batch and notify', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Success,
        createMockResponse(call.request.callId),
      );
      stateManager.finalizeCall(call.request.callId);

      stateManager.clearBatch();

      expect(stateManager.completedBatch).toHaveLength(0);
      expect(onUpdate).toHaveBeenCalledWith([]);
    });

    it('should return a copy of the completed batch (defensive)', () => {
      const call = createValidatingCall();
      stateManager.addActiveCall(call);
      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Success,
        createMockResponse(call.request.callId),
      );
      stateManager.finalizeCall(call.request.callId);

      const batch = stateManager.completedBatch;
      expect(batch).toHaveLength(1);

      // Mutate the returned array
      batch.pop();
      expect(batch).toHaveLength(0);

      // Verify internal state is unchanged
      expect(stateManager.completedBatch).toHaveLength(1);
    });
  });

  describe('Snapshot and Ordering', () => {
    it('should return snapshot in order: completed, active', () => {
      // 1. Completed
      const call1 = createValidatingCall('1');
      stateManager.addActiveCall(call1);
      stateManager.updateStatus(
        '1',
        CoreToolCallStatus.Success,
        createMockResponse('1'),
      );
      stateManager.finalizeCall('1');

      // 2. Active
      const call2 = createValidatingCall('2');
      stateManager.addActiveCall(call2);

      const snapshot = stateManager.getSnapshot();
      expect(snapshot).toHaveLength(2);
      expect(snapshot[0].request.callId).toBe('1');
      expect(snapshot[1].request.callId).toBe('2');
    });
  });

  describe('progress field preservation', () => {
    it('should preserve progress and progressTotal in toExecuting', () => {
      const call = createValidatingCall('progress-1');
      stateManager.addActiveCall(call);

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          progress: 5,
          progressTotal: 10,
          progressMessage: 'Working',
          progressPercent: 50,
        },
      );

      const active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.status).toBe(CoreToolCallStatus.Executing);
      expect(active.progress).toBe(5);
      expect(active.progressTotal).toBe(10);
      expect(active.progressMessage).toBe('Working');
      expect(active.progressPercent).toBe(50);
    });

    it('should preserve progress fields after a liveOutput update', () => {
      const call = createValidatingCall('progress-2');
      stateManager.addActiveCall(call);

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          progress: 5,
          progressTotal: 10,
          progressMessage: 'Working',
          progressPercent: 50,
        },
      );

      stateManager.updateStatus(
        call.request.callId,
        CoreToolCallStatus.Executing,
        {
          liveOutput: 'some output',
        },
      );

      const active = stateManager.firstActiveCall as ExecutingToolCall;
      expect(active.status).toBe(CoreToolCallStatus.Executing);
      expect(active.liveOutput).toBe('some output');
      expect(active.progress).toBe(5);
      expect(active.progressTotal).toBe(10);
      expect(active.progressMessage).toBe('Working');
      expect(active.progressPercent).toBe(50);
    });
  });

  // Regression: the terminal-state constructors used to read `startTime` only
  // to compute `durationMs` and never put `startTime`/`endTime` on the returned
  // call, so `tool_invoked.start_time_ms` / `end_time_ms` were always empty.
  describe('terminal timing fields', () => {
    // `updateStatus` is overloaded per status, so each row drives its own call.
    const terminalTransitions: Array<{
      label: string;
      transition: (callId: string) => void;
    }> = [
      {
        label: 'successful',
        transition: (callId) =>
          stateManager.updateStatus(
            callId,
            CoreToolCallStatus.Success,
            createMockResponse(callId),
          ),
      },
      {
        label: 'errored',
        transition: (callId) =>
          stateManager.updateStatus(callId, CoreToolCallStatus.Error, {
            ...createMockResponse(callId),
            error: new Error('Failed'),
          }),
      },
      {
        label: 'cancelled',
        transition: (callId) =>
          stateManager.updateStatus(
            callId,
            CoreToolCallStatus.Cancelled,
            'user cancelled',
          ),
      },
    ];

    describe.each([6.5 * 3600_000, -8 * 3600_000])('wall-clock jump %s ms', (jump) => {
      it.each(terminalTransitions)('keeps monotonic elapsed time for $label', ({ transition }) => {
        const wall = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
        try {
          const call = createValidatingCall();
          stateManager.addActiveCall(call);
          clock.mockReturnValue(25);
          stateManager.updateStatus(call.request.callId, CoreToolCallStatus.Scheduled);
          wall.mockReturnValue(1_800_000_000_000 + jump);
          clock.mockReturnValue(150);
          transition(call.request.callId);
          stateManager.finalizeCall(call.request.callId);
          expect(stateManager.completedBatch[0]).toMatchObject({
            startTime: 1_800_000_000_000,
            endTime: 1_800_000_000_000 + jump,
            durationMs: 150,
          });
        } finally {
          wall.mockRestore();
          clock.mockRestore();
        }
      });
    });

    it.each(terminalTransitions)(
      'should carry startTime/endTime into a $label call',
      ({ transition }) => {
        const call = createValidatingCall();
        stateManager.addActiveCall(call);

        transition(call.request.callId);
        stateManager.finalizeCall(call.request.callId);

        const completed = stateManager.completedBatch[0] as
          | SuccessfulToolCall
          | ErroredToolCall
          | CancelledToolCall;
        expect(completed.startTime).toBe(call.startTime);
        expect(completed.endTime).toBeGreaterThanOrEqual(call.startTime!);
        expect(completed.durationMs).toBeGreaterThanOrEqual(0);
      },
    );
  });
});
