/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentTracker } from './SubAgentTracker.js';
import type { SessionContext } from './types.js';
import type {
  Config,
  ToolRegistry,
  SubAgentEventEmitter,
  SubAgentToolCallEvent,
  SubAgentToolResultEvent,
  SubAgentApprovalRequestEvent,
  ToolEditConfirmationDetails,
  ToolInfoConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import {
  SubAgentEventType,
  ToolConfirmationOutcome,
  TodoWriteTool,
} from '@qwen-code/qwen-code-core';
import type * as acp from '../acp.js';
import { EventEmitter } from 'node:events';

// Helper to create a mock SubAgentToolCallEvent with required fields
function createToolCallEvent(
  overrides: Partial<SubAgentToolCallEvent> & { name: string; callId: string },
): SubAgentToolCallEvent {
  return {
    subagentId: 'test-subagent',
    round: 1,
    timestamp: Date.now(),
    description: `Calling ${overrides.name}`,
    args: {},
    ...overrides,
  };
}

// Helper to create a mock SubAgentToolResultEvent with required fields
function createToolResultEvent(
  overrides: Partial<SubAgentToolResultEvent> & {
    name: string;
    callId: string;
    success: boolean;
  },
): SubAgentToolResultEvent {
  return {
    subagentId: 'test-subagent',
    round: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

// Helper to create a mock SubAgentApprovalRequestEvent with required fields
function createApprovalEvent(
  overrides: Partial<SubAgentApprovalRequestEvent> & {
    name: string;
    callId: string;
    confirmationDetails: SubAgentApprovalRequestEvent['confirmationDetails'];
    respond: SubAgentApprovalRequestEvent['respond'];
  },
): SubAgentApprovalRequestEvent {
  return {
    subagentId: 'test-subagent',
    round: 1,
    timestamp: Date.now(),
    description: `Awaiting approval for ${overrides.name}`,
    ...overrides,
  };
}

// Helper to create edit confirmation details
function createEditConfirmation(
  overrides: Partial<Omit<ToolEditConfirmationDetails, 'onConfirm' | 'type'>>,
): Omit<ToolEditConfirmationDetails, 'onConfirm'> {
  return {
    type: 'edit',
    title: 'Edit file',
    fileName: '/test.ts',
    filePath: '/test.ts',
    fileDiff: '',
    originalContent: '',
    newContent: '',
    ...overrides,
  };
}

// Helper to create info confirmation details
function createInfoConfirmation(
  overrides?: Partial<Omit<ToolInfoConfirmationDetails, 'onConfirm' | 'type'>>,
): Omit<ToolInfoConfirmationDetails, 'onConfirm'> {
  return {
    type: 'info',
    title: 'Tool requires approval',
    prompt: 'Allow this action?',
    ...overrides,
  };
}

describe('SubAgentTracker', () => {
  let mockContext: SessionContext;
  let mockClient: acp.Client;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let requestPermissionSpy: ReturnType<typeof vi.fn>;
  let tracker: SubAgentTracker;
  let eventEmitter: SubAgentEventEmitter;
  let abortController: AbortController;

  beforeEach(() => {
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    requestPermissionSpy = vi.fn().mockResolvedValue({
      outcome: { optionId: ToolConfirmationOutcome.ProceedOnce },
    });

    const mockToolRegistry = {
      getTool: vi.fn().mockReturnValue(null),
    } as unknown as ToolRegistry;

    mockContext = {
      sessionId: 'test-session-id',
      config: {
        getToolRegistry: () => mockToolRegistry,
      } as unknown as Config,
      sendUpdate: sendUpdateSpy,
    };

    mockClient = {
      requestPermission: requestPermissionSpy,
    } as unknown as acp.Client;

    tracker = new SubAgentTracker(mockContext, mockClient);
    eventEmitter = new EventEmitter() as unknown as SubAgentEventEmitter;
    abortController = new AbortController();
  });

  describe('setup', () => {
    it('should return cleanup function', () => {
      const cleanups = tracker.setup(eventEmitter, abortController.signal);

      expect(cleanups).toHaveLength(1);
      expect(typeof cleanups[0]).toBe('function');
    });

    it('should register event listeners', () => {
      const onSpy = vi.spyOn(eventEmitter, 'on');

      tracker.setup(eventEmitter, abortController.signal);

      expect(onSpy).toHaveBeenCalledWith(
        SubAgentEventType.TOOL_CALL,
        expect.any(Function),
      );
      expect(onSpy).toHaveBeenCalledWith(
        SubAgentEventType.TOOL_RESULT,
        expect.any(Function),
      );
      expect(onSpy).toHaveBeenCalledWith(
        SubAgentEventType.TOOL_WAITING_APPROVAL,
        expect.any(Function),
      );
    });

    it('should remove event listeners on cleanup', () => {
      const offSpy = vi.spyOn(eventEmitter, 'off');
      const cleanups = tracker.setup(eventEmitter, abortController.signal);

      cleanups[0]();

      expect(offSpy).toHaveBeenCalledWith(
        SubAgentEventType.TOOL_CALL,
        expect.any(Function),
      );
      expect(offSpy).toHaveBeenCalledWith(
        SubAgentEventType.TOOL_RESULT,
        expect.any(Function),
      );
      expect(offSpy).toHaveBeenCalledWith(
        SubAgentEventType.TOOL_WAITING_APPROVAL,
        expect.any(Function),
      );
    });
  });

  describe('tool call handling', () => {
    it('should emit tool_call on TOOL_CALL event', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      const event = createToolCallEvent({
        name: 'read_file',
        callId: 'call-123',
        args: { path: '/test.ts' },
        description: 'Reading file',
      });

      eventEmitter.emit(SubAgentEventType.TOOL_CALL, event);

      // Allow async operations to complete
      await vi.waitFor(() => {
        expect(sendUpdateSpy).toHaveBeenCalled();
      });

      // ToolCallEmitter resolves metadata from registry - uses toolName when tool not found
      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-123',
          status: 'pending',
          title: 'read_file',
          content: [],
          locations: [],
          kind: 'other',
          rawInput: { path: '/test.ts' },
        }),
      );
    });

    it('should skip tool_call for TodoWriteTool', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      const event = createToolCallEvent({
        name: TodoWriteTool.Name,
        callId: 'call-todo',
        args: { todos: [] },
      });

      eventEmitter.emit(SubAgentEventType.TOOL_CALL, event);

      // Give time for any async operation
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });

    it('should not emit when aborted', async () => {
      tracker.setup(eventEmitter, abortController.signal);
      abortController.abort();

      const event = createToolCallEvent({
        name: 'read_file',
        callId: 'call-123',
        args: {},
      });

      eventEmitter.emit(SubAgentEventType.TOOL_CALL, event);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });
  });

  describe('tool result handling', () => {
    it('should emit tool_call_update on TOOL_RESULT event', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      // First emit tool call to store state
      eventEmitter.emit(
        SubAgentEventType.TOOL_CALL,
        createToolCallEvent({
          name: 'read_file',
          callId: 'call-123',
          args: { path: '/test.ts' },
        }),
      );

      // Then emit result
      const resultEvent = createToolResultEvent({
        name: 'read_file',
        callId: 'call-123',
        success: true,
        resultDisplay: 'File contents',
      });

      eventEmitter.emit(SubAgentEventType.TOOL_RESULT, resultEvent);

      await vi.waitFor(() => {
        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-123',
            status: 'completed',
          }),
        );
      });
    });

    it('should emit failed status on unsuccessful result', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      const resultEvent = createToolResultEvent({
        name: 'read_file',
        callId: 'call-fail',
        success: false,
        resultDisplay: undefined,
      });

      eventEmitter.emit(SubAgentEventType.TOOL_RESULT, resultEvent);

      await vi.waitFor(() => {
        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            status: 'failed',
          }),
        );
      });
    });

    it('should emit plan update for TodoWriteTool results', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      // Store args via tool call
      eventEmitter.emit(
        SubAgentEventType.TOOL_CALL,
        createToolCallEvent({
          name: TodoWriteTool.Name,
          callId: 'call-todo',
          args: {
            todos: [{ id: '1', content: 'Task 1', status: 'pending' }],
          },
        }),
      );

      // Emit result with todo_list display
      const resultEvent = createToolResultEvent({
        name: TodoWriteTool.Name,
        callId: 'call-todo',
        success: true,
        resultDisplay: JSON.stringify({
          type: 'todo_list',
          todos: [{ id: '1', content: 'Task 1', status: 'completed' }],
        }),
      });

      eventEmitter.emit(SubAgentEventType.TOOL_RESULT, resultEvent);

      await vi.waitFor(() => {
        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'plan',
          entries: [
            { content: 'Task 1', priority: 'medium', status: 'completed' },
          ],
        });
      });
    });

    it('should clean up state after result', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      eventEmitter.emit(
        SubAgentEventType.TOOL_CALL,
        createToolCallEvent({
          name: 'test_tool',
          callId: 'call-cleanup',
          args: { test: true },
        }),
      );

      eventEmitter.emit(
        SubAgentEventType.TOOL_RESULT,
        createToolResultEvent({
          name: 'test_tool',
          callId: 'call-cleanup',
          success: true,
        }),
      );

      // Emit another result for same callId - should not have stored args
      sendUpdateSpy.mockClear();
      eventEmitter.emit(
        SubAgentEventType.TOOL_RESULT,
        createToolResultEvent({
          name: 'test_tool',
          callId: 'call-cleanup',
          success: true,
        }),
      );

      await vi.waitFor(() => {
        expect(sendUpdateSpy).toHaveBeenCalled();
      });

      // Second call should not have args from first call
      // (state was cleaned up)
    });
  });

  describe('approval handling', () => {
    it('should request permission from client', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      const respondSpy = vi.fn().mockResolvedValue(undefined);
      const event = createApprovalEvent({
        name: 'edit_file',
        callId: 'call-edit',
        description: 'Editing file',
        confirmationDetails: createEditConfirmation({
          fileName: '/test.ts',
          originalContent: 'old',
          newContent: 'new',
        }),
        respond: respondSpy,
      });

      eventEmitter.emit(SubAgentEventType.TOOL_WAITING_APPROVAL, event);

      await vi.waitFor(() => {
        expect(requestPermissionSpy).toHaveBeenCalled();
      });

      expect(requestPermissionSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'test-session-id',
          toolCall: expect.objectContaining({
            toolCallId: 'call-edit',
            status: 'pending',
            content: [
              {
                type: 'diff',
                path: '/test.ts',
                oldText: 'old',
                newText: 'new',
              },
            ],
          }),
        }),
      );
    });

    it('should respond to subagent with permission outcome', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      const respondSpy = vi.fn().mockResolvedValue(undefined);
      const event = createApprovalEvent({
        name: 'test_tool',
        callId: 'call-123',
        confirmationDetails: createInfoConfirmation(),
        respond: respondSpy,
      });

      eventEmitter.emit(SubAgentEventType.TOOL_WAITING_APPROVAL, event);

      await vi.waitFor(() => {
        expect(respondSpy).toHaveBeenCalledWith(
          ToolConfirmationOutcome.ProceedOnce,
        );
      });
    });

    it('should cancel on permission request failure', async () => {
      requestPermissionSpy.mockRejectedValue(new Error('Network error'));
      tracker.setup(eventEmitter, abortController.signal);

      const respondSpy = vi.fn().mockResolvedValue(undefined);
      const event = createApprovalEvent({
        name: 'test_tool',
        callId: 'call-123',
        confirmationDetails: createInfoConfirmation(),
        respond: respondSpy,
      });

      eventEmitter.emit(SubAgentEventType.TOOL_WAITING_APPROVAL, event);

      await vi.waitFor(() => {
        expect(respondSpy).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      });
    });

    it('should handle cancelled outcome from client', async () => {
      requestPermissionSpy.mockResolvedValue({
        outcome: { outcome: 'cancelled' },
      });
      tracker.setup(eventEmitter, abortController.signal);

      const respondSpy = vi.fn().mockResolvedValue(undefined);
      const event = createApprovalEvent({
        name: 'test_tool',
        callId: 'call-123',
        confirmationDetails: createInfoConfirmation(),
        respond: respondSpy,
      });

      eventEmitter.emit(SubAgentEventType.TOOL_WAITING_APPROVAL, event);

      await vi.waitFor(() => {
        expect(respondSpy).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
      });
    });
  });

  describe('permission options', () => {
    it('should include "Allow All Edits" for edit type', async () => {
      tracker.setup(eventEmitter, abortController.signal);

      const event = createApprovalEvent({
        name: 'edit_file',
        callId: 'call-123',
        confirmationDetails: createEditConfirmation({
          fileName: '/test.ts',
          originalContent: '',
          newContent: 'new',
        }),
        respond: vi.fn(),
      });

      eventEmitter.emit(SubAgentEventType.TOOL_WAITING_APPROVAL, event);

      await vi.waitFor(() => {
        expect(requestPermissionSpy).toHaveBeenCalled();
      });

      const call = requestPermissionSpy.mock.calls[0][0];
      expect(call.options).toContainEqual(
        expect.objectContaining({
          optionId: ToolConfirmationOutcome.ProceedAlways,
          name: 'Allow All Edits',
        }),
      );
    });
  });
});
