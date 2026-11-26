/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapToDisplay } from './toolMapping.js';
import {
  type AnyDeclarativeTool,
  type AnyToolInvocation,
  type ToolCallRequestInfo,
  type ToolCallResponseInfo,
  type Status,
  type ToolCall,
  type ScheduledToolCall,
  type SuccessfulToolCall,
  type ExecutingToolCall,
  type WaitingToolCall,
  type CancelledToolCall,
  CoreToolCallStatus,
  ASK_USER_TOOL_NAME,
  IMAGE_GEN_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  ToolErrorType,
  WORKFLOW_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  Kind,
} from '@qwen-code/core';
import { ToolCallStatus, mapCoreStatusToDisplayStatus } from '../types.js';

describe('toolMapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapCoreStatusToDisplayStatus', () => {
    it.each([
      [CoreToolCallStatus.Validating, ToolCallStatus.Pending],
      [CoreToolCallStatus.AwaitingApproval, ToolCallStatus.Confirming],
      [CoreToolCallStatus.Executing, ToolCallStatus.Executing],
      [CoreToolCallStatus.Success, ToolCallStatus.Success],
      [CoreToolCallStatus.Cancelled, ToolCallStatus.Canceled],
      [CoreToolCallStatus.Error, ToolCallStatus.Error],
      [CoreToolCallStatus.Scheduled, ToolCallStatus.Pending],
    ] as const)('maps %s to %s', (coreStatus, expectedDisplayStatus) => {
      expect(mapCoreStatusToDisplayStatus(coreStatus)).toBe(
        expectedDisplayStatus,
      );
    });

    it('throws error for unknown status due to checkExhaustive', () => {
      expect(() =>
        mapCoreStatusToDisplayStatus('unknown_status' as Status),
      ).toThrow('unexpected value unknown_status!');
    });
  });

  describe('mapToDisplay', () => {
    const mockRequest: ToolCallRequestInfo = {
      callId: 'call-1',
      name: 'test_tool',
      args: { arg1: 'val1' },
      prompt_id: 'p1',
    };

    const mockTool = {
      name: 'test_tool',
      displayName: 'Test Tool',
      isOutputMarkdown: true,
    } as unknown as AnyDeclarativeTool;
    const mockAgentTool = {
      name: 'Agent',
      displayName: 'Agent',
      isOutputMarkdown: true,
      kind: Kind.Agent,
    } as unknown as AnyDeclarativeTool;
    const mockWorkflowTool = {
      name: WORKFLOW_TOOL_NAME,
      displayName: 'Workflow',
      isOutputMarkdown: true,
      kind: Kind.Workflow,
    } as unknown as AnyDeclarativeTool;

    const mockInvocation = {
      getDescription: () => 'Calling test_tool with args...',
    } as unknown as AnyToolInvocation;

    const mockResponse: ToolCallResponseInfo = {
      callId: 'call-1',
      responseParts: [],
      resultDisplay: 'Success output',
      error: undefined,
      errorType: undefined,
    };

    it('handles a single tool call input', () => {
      const toolCall: ScheduledToolCall = {
        status: CoreToolCallStatus.Scheduled,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
      };

      const result = mapToDisplay(toolCall);
      expect(result.type).toBe('tool_group');
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0]?.callId).toBe('call-1');
    });

    it('handles an array of tool calls', () => {
      const toolCall1: ScheduledToolCall = {
        status: CoreToolCallStatus.Scheduled,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
      };
      const toolCall2: ScheduledToolCall = {
        status: CoreToolCallStatus.Scheduled,
        request: { ...mockRequest, callId: 'call-2' },
        tool: mockTool,
        invocation: mockInvocation,
      };

      const result = mapToDisplay([toolCall1, toolCall2]);
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0]?.callId).toBe('call-1');
      expect(result.tools[1]?.callId).toBe('call-2');
    });

    it.each(['mcp__demo__u_611aec98eddc', 'mcp_call'])(
      'shows the original MCP name for live %s calls',
      (name) => {
        const toolCall: ScheduledToolCall = {
          status: CoreToolCallStatus.Scheduled,
          request: {
            ...mockRequest,
            name,
            args:
              name === 'mcp_call'
                ? {
                    toolName: 'mcp__demo__u_611aec98eddc',
                    arguments: { id: 'demo-001' },
                  }
                : { id: 'demo-001' },
            mcpInfo: { serverName: '转换服务', toolName: '文档格式转换_查询' },
          },
          tool: mockTool,
          invocation: mockInvocation,
        };
        expect(mapToDisplay(toolCall).tools[0]).toMatchObject({
          callId: mockRequest.callId,
          name: '文档格式转换_查询 (转换服务 MCP Server)',
          description: '{"id":"demo-001"}',
        });
        expect(toolCall.request.name).toBe(name);
      },
    );

    it('maps successful tool call properties correctly', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          outputFile: '/tmp/output.txt',
        },
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool).toEqual(
        expect.objectContaining({
          callId: 'call-1',
          name: 'test_tool',
          description: '{"arg1":"val1"}',
          renderOutputAsMarkdown: true,
          status: CoreToolCallStatus.Success,
          resultDisplay: undefined,
          outputFile: '/tmp/output.txt',
        }),
      );
    });

    it('prefers semantic response data over runtime display text', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: SHELL_TOOL_NAME },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: { stdout: 'semantic output', exitCode: 0 },
          resultDisplay: 'display output',
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe('semantic output');
    });

    it('projects CodeMode semantic failures as errors while preserving their output', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: 'CodeMode' },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          isError: true,
          toolUseResult: {
            type: 'code_mode',
            status: 'error',
            error: 'SyntaxError: invalid property name\nat code:2:10',
            output: '',
            calls: [],
          },
        },
      };

      const display = mapToDisplay(toolCall).tools[0];

      expect(display.status).toBe(CoreToolCallStatus.Error);
      expect(display.resultDisplay).toMatchObject({
        children: [],
        status: 'error',
        summary: 'SyntaxError: invalid property name\nat code:2:10',
      });
      expect(toolCall.status).toBe(CoreToolCallStatus.Success);
    });

    it('projects background shell status from shell-shaped toolUseResult', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: SHELL_TOOL_NAME },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: {
            stdout: 'Background process started with PID 12345.',
            initialOutput: '',
            pid: 12345,
          },
          resultDisplay: 'legacy background display',
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe(
        'Background process started with PID 12345.',
      );
    });

    it('projects completed background shell status instead of initial output', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: SHELL_TOOL_NAME },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: {
            initialOutput: 'test\n'.repeat(100),
            pid: 12345,
            taskId: 'task-1',
            backgroundReason: 'timeout',
            totalLines: 101,
            totalBytes: 505,
          },
          resultDisplay: 'legacy background display',
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe(
        'Command exceeded its timeout and was moved to background (ID: task-1). Use /tasks to view.',
      );
      expect(result.tools[0].shellProgress).toBeUndefined();
    });

    it('projects structured toolUseResult from response data', () => {
      const fileDiff = {
        fileDiff: '--- a/app.ts\n+++ b/app.ts\n@@\n+export const x = 1;\n',
        fileName: 'app.ts',
        filePath: '/tmp/app.ts',
        originalContent: null,
        newContent: 'export const x = 1;\n',
      };
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: WRITE_FILE_TOOL_NAME },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: fileDiff,
          resultDisplay: 'runtime display output',
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toEqual(fileDiff);
    });

    it('does not project ToolResult returnDisplay from response data', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          data: {
            llmContent: 'full file content',
            returnDisplay: 'Read 20 lines',
          },
          resultDisplay: 'runtime display output',
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBeUndefined();
    });

    it('uses workflow runtime display instead of structured payload', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: {
          ...mockRequest,
          name: WORKFLOW_TOOL_NAME,
          args: { name: 'deep-research' },
        },
        tool: mockWorkflowTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: {
            summary: 'Deep research harness',
            payload: '{"status":"async_launched"}',
          },
          resultDisplay: 'Running in background · /workflows to monitor and save',
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].kind).toBe(Kind.Workflow);
      expect(result.tools[0].resultDisplay).toBe(
        'Running in background · /workflows to monitor and save',
      );
    });

    it('uses workflow launch display when only structured payload is available', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: {
          ...mockRequest,
          name: WORKFLOW_TOOL_NAME,
          args: { name: 'research-opencode' },
        },
        tool: mockWorkflowTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: {
            summary:
              'Research opencode implementation - architecture, key modules, and design patterns',
            payload: JSON.stringify({
              status: 'async_launched',
              taskId: 'workflow-task-1',
              runId: 'wf_1',
            }),
          },
          resultDisplay: undefined,
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].kind).toBe(Kind.Workflow);
      expect(result.tools[0].description).toBe(
        'dynamic workflow: research-opencode',
      );
      expect(result.tools[0].resultDisplay).toBe(
        'Running in background · /workflows to monitor and save',
      );
      expect(result.tools[0].resultDisplay).not.toContain('architecture');
    });

    it('projects Read file-not-found errors from structured toolUseResult', () => {
      const toolCall: ToolCall = {
        status: CoreToolCallStatus.Error,
        request: {
          ...mockRequest,
          name: READ_FILE_TOOL_NAME,
          args: { file_path: '/repo/src/missing.ts' },
        },
        response: {
          ...mockResponse,
          error: new Error(
            'File does not exist. Note: your current working directory is /repo.',
          ),
          errorType: ToolErrorType.FILE_NOT_FOUND,
          toolUseResult: { errorType: ToolErrorType.FILE_NOT_FOUND },
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe('File not found.');
    });

    it('projects AskUserQuestion answers from structured toolUseResult', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: ASK_USER_TOOL_NAME },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult: {
            questions: [
              {
                question: 'Which approach?',
                header: 'Approach',
                options: [
                  { label: 'A', description: 'Option A' },
                  { label: 'B', description: 'Option B' },
                ],
                multiSelect: false,
              },
            ],
            answers: {
              'Which approach?': 'A',
            },
          },
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe(
        '**User answered:**\n  Q: Which approach?\n  Approach → A',
      );
    });

    it('projects generic structured payload results for tools without custom renderers', () => {
      const toolUseResult = {
        summary: 'Image saved to /tmp/image.png',
        payload: '/tmp/image.png',
      };
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: IMAGE_GEN_TOOL_NAME },
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          toolUseResult,
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toEqual(toolUseResult);
    });

    it('uses Agent resultDisplay for TUI activity instead of persisted toolUseResult', () => {
      const progressDisplay = {
        isSubagentProgress: true as const,
        agentName: 'MockAgent',
        state: 'completed' as const,
        result: 'done',
        recentActivity: [
          {
            id: 'activity-1',
            type: 'thought' as const,
            content: 'working',
            status: 'completed' as const,
          },
        ],
      };
      const persistedResult = {
        kind: 'agent-result',
        agentType: 'MockAgent',
        content: 'done',
        state: 'completed',
      };
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: 'Agent' },
        tool: mockAgentTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          resultDisplay: progressDisplay,
          toolUseResult: persistedResult,
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toEqual(progressDisplay);
    });

    it('projects persisted Agent result through the Agent-specific display path', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: 'Agent' },
        tool: mockAgentTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          resultDisplay: undefined,
          toolUseResult: {
            kind: 'agent-result',
            agentType: 'MockAgent',
            content: 'final assistant response',
            state: 'completed',
          },
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe('final assistant response');
    });

    it('projects Agent background launch display text through the Agent-specific display path', () => {
      const launchMessage =
        "Agent 'MockAgent' is running in the background. A task notification will be delivered when it finishes.";
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: 'Agent' },
        tool: mockAgentTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          resultDisplay: launchMessage,
          toolUseResult: {
            summary: launchMessage,
            payload: 'task-123',
          },
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toBe(launchMessage);
    });

    it('projects persisted Agent background launch payload through the Agent-specific display path', () => {
      const launchResult = {
        summary:
          "Agent 'MockAgent' is running in the background. A task notification will be delivered when it finishes.",
        payload: 'task-123',
      };
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: { ...mockRequest, name: 'Agent' },
        tool: mockAgentTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          resultDisplay: undefined,
          toolUseResult: launchResult,
        },
      };

      const result = mapToDisplay(toolCall);

      expect(result.tools[0].resultDisplay).toEqual(launchResult);
    });

    it('maps executing tool call properties correctly with live output and executionId', () => {
      const toolCall: ExecutingToolCall = {
        status: CoreToolCallStatus.Executing,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        liveOutput: 'Loading...',
        pid: 12345,
        executionStartedAt: 123456,
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.status).toBe(CoreToolCallStatus.Executing);
      expect(displayTool.resultDisplay).toBe('Loading...');
      expect(displayTool.executionId).toBe(12345);
      expect(displayTool.startedAt).toBe(123456);
    });

    it('maps shell live output metadata to shellProgress', () => {
      const toolCall: ExecutingToolCall = {
        status: CoreToolCallStatus.Executing,
        request: {
          ...mockRequest,
          name: SHELL_TOOL_NAME,
          args: { command: 'while true; do echo test; done' },
        },
        tool: {
          name: SHELL_TOOL_NAME,
          displayName: SHELL_TOOL_NAME,
          isOutputMarkdown: mockTool.isOutputMarkdown,
        } as unknown as AnyDeclarativeTool,
        invocation: mockInvocation,
        liveOutput: {
          isShellLiveOutput: true,
          output: 'test\n'.repeat(100),
          totalLines: 101,
          totalBytes: 505,
        },
        pid: 12345,
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.resultDisplay).toBe('test\n'.repeat(100));
      expect(displayTool.shellProgress).toEqual({
        totalLines: 101,
        totalBytes: 505,
      });
      expect(displayTool.executionId).toBe(12345);
    });

    it('maps awaiting_approval tool call properties with correlationId', () => {
      const confirmationDetails = {
        type: 'exec' as const,
        title: 'Confirm Exec',
        command: 'ls',
        rootCommand: 'ls',
        rootCommands: ['ls'],
        onConfirm: vi.fn(),
      };

      const toolCall: WaitingToolCall = {
        status: CoreToolCallStatus.AwaitingApproval,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        confirmationDetails,
        correlationId: 'corr-id-123',
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.status).toBe(CoreToolCallStatus.AwaitingApproval);
      expect(displayTool.confirmationDetails).toEqual(confirmationDetails);
    });

    it('maps correlationId and serializable confirmation details', () => {
      const serializableDetails = {
        type: 'edit' as const,
        title: 'Confirm Edit',
        fileName: 'file.txt',
        filePath: '/path/file.txt',
        fileDiff: 'diff',
        originalContent: 'old',
        newContent: 'new',
      };

      const toolCall: WaitingToolCall = {
        status: CoreToolCallStatus.AwaitingApproval,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        confirmationDetails: serializableDetails,
        correlationId: 'corr-123',
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.correlationId).toBe('corr-123');
      expect(displayTool.confirmationDetails).toEqual(serializableDetails);
    });

    it('does not render unstructured error message content', () => {
      // e.g. "TOOL_NOT_REGISTERED" errors
      const toolCall: ToolCall = {
        status: CoreToolCallStatus.Error,
        request: mockRequest, // name: 'test_tool'
        response: { ...mockResponse, error: new Error('Tool not found') },
        // notice: no `tool` or `invocation` defined here
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.status).toBe(CoreToolCallStatus.Error);
      expect(displayTool.name).toBe('test_tool'); // falls back to request.name
      expect(displayTool.description).toBe('{"arg1":"val1"}'); // falls back to stringified args
      expect(displayTool.resultDisplay).toBeUndefined();
      expect(displayTool.renderOutputAsMarkdown).toBe(false);
    });

    it('does not render unstructured cancelled message content', () => {
      const toolCall: CancelledToolCall = {
        status: CoreToolCallStatus.Cancelled,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          error: new Error('User cancelled'),
        },
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.status).toBe(CoreToolCallStatus.Cancelled);
      expect(displayTool.resultDisplay).toBeUndefined();
    });

    it('projects structured cancelled status result', () => {
      const toolCall: CancelledToolCall = {
        status: CoreToolCallStatus.Cancelled,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        response: {
          ...mockResponse,
          error: new Error('User cancelled'),
          toolUseResult: {
            kind: 'tool-status',
            status: 'cancelled',
            summary: 'User cancelled.',
          },
        },
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.status).toBe(CoreToolCallStatus.Cancelled);
      expect(displayTool.resultDisplay).toBe('User cancelled.');
    });

    it('propagates borderTop and borderBottom options correctly', () => {
      const toolCall: ScheduledToolCall = {
        status: CoreToolCallStatus.Scheduled,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
      };

      const result = mapToDisplay(toolCall, {
        borderTop: true,
        borderBottom: false,
      });
      expect(result.borderTop).toBe(true);
      expect(result.borderBottom).toBe(false);
    });

    it('maps raw progress and progressTotal from Executing calls', () => {
      const toolCall: ExecutingToolCall = {
        status: CoreToolCallStatus.Executing,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        progressMessage: 'Downloading...',
        progress: 5,
        progressTotal: 10,
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.progress).toBe(5);
      expect(displayTool.progressTotal).toBe(10);
      expect(displayTool.progressMessage).toBe('Downloading...');
    });

    it('leaves progress fields undefined for non-Executing calls', () => {
      const toolCall: SuccessfulToolCall = {
        status: CoreToolCallStatus.Success,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
        response: mockResponse,
      };

      const result = mapToDisplay(toolCall);
      const displayTool = result.tools[0];

      expect(displayTool.progress).toBeUndefined();
      expect(displayTool.progressTotal).toBeUndefined();
    });

    it('sets resultDisplay to undefined for pre-execution statuses', () => {
      const toolCall: ScheduledToolCall = {
        status: CoreToolCallStatus.Scheduled,
        request: mockRequest,
        tool: mockTool,
        invocation: mockInvocation,
      };

      const result = mapToDisplay(toolCall);
      expect(result.tools[0].resultDisplay).toBeUndefined();
      expect(result.tools[0].status).toBe(CoreToolCallStatus.Scheduled);
    });

    it('propagates originalRequestName correctly', () => {
      const toolCall: ScheduledToolCall = {
        status: CoreToolCallStatus.Scheduled,
        request: {
          ...mockRequest,
          originalRequestName: 'original_tool',
        },
        tool: mockTool,
        invocation: mockInvocation,
      };

      const result = mapToDisplay(toolCall);
      expect(result.tools[0].originalRequestName).toBe('original_tool');
    });
  });
});
