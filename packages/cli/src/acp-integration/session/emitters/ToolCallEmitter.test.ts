/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallEmitter } from './ToolCallEmitter.js';
import type { SessionContext } from '../types.js';
import type {
  Config,
  ToolRegistry,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '@qwen-code/qwen-code-core';
import { Kind, TodoWriteTool } from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';

// Helper to create mock message parts for tests
const createMockMessage = (text?: string): Part[] =>
  text
    ? [{ functionResponse: { name: 'test', response: { output: text } } }]
    : [];

describe('ToolCallEmitter', () => {
  let mockContext: SessionContext;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let mockToolRegistry: ToolRegistry;
  let emitter: ToolCallEmitter;

  // Helper to create mock tool
  const createMockTool = (
    overrides: Partial<AnyDeclarativeTool> = {},
  ): AnyDeclarativeTool =>
    ({
      name: 'test_tool',
      kind: Kind.Other,
      build: vi.fn().mockReturnValue({
        getDescription: () => 'Test tool description',
        toolLocations: () => [{ path: '/test/file.ts', line: 10 }],
      } as unknown as AnyToolInvocation),
      ...overrides,
    }) as unknown as AnyDeclarativeTool;

  beforeEach(() => {
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    mockToolRegistry = {
      getTool: vi.fn().mockReturnValue(null),
    } as unknown as ToolRegistry;

    mockContext = {
      sessionId: 'test-session-id',
      config: {
        getToolRegistry: () => mockToolRegistry,
      } as unknown as Config,
      sendUpdate: sendUpdateSpy,
    };

    emitter = new ToolCallEmitter(mockContext);
  });

  describe('emitStart', () => {
    it('should emit tool_call update with basic params when tool not in registry', async () => {
      const result = await emitter.emitStart({
        toolName: 'unknown_tool',
        callId: 'call-123',
        args: { arg1: 'value1' },
      });

      expect(result).toBe(true);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-123',
        status: 'in_progress',
        title: 'unknown_tool', // Falls back to tool name
        content: [],
        locations: [],
        kind: 'other',
        rawInput: { arg1: 'value1' },
      });
    });

    it('should emit tool_call with resolved metadata when tool is in registry', async () => {
      const mockTool = createMockTool({ kind: Kind.Edit });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      const result = await emitter.emitStart({
        toolName: 'edit_file',
        callId: 'call-456',
        args: { path: '/test.ts' },
      });

      expect(result).toBe(true);
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-456',
        status: 'in_progress',
        title: 'edit_file: Test tool description',
        content: [],
        locations: [{ path: '/test/file.ts', line: 10 }],
        kind: 'edit',
        rawInput: { path: '/test.ts' },
      });
    });

    it('should skip emit for TodoWriteTool and return false', async () => {
      const result = await emitter.emitStart({
        toolName: TodoWriteTool.Name,
        callId: 'call-todo',
        args: { todos: [] },
      });

      expect(result).toBe(false);
      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });

    it('should handle empty args', async () => {
      await emitter.emitStart({
        toolName: 'test_tool',
        callId: 'call-empty',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rawInput: {},
        }),
      );
    });

    it('should fall back gracefully when tool build fails', async () => {
      const mockTool = createMockTool();
      vi.mocked(mockTool.build).mockImplementation(() => {
        throw new Error('Build failed');
      });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      await emitter.emitStart({
        toolName: 'failing_tool',
        callId: 'call-fail',
        args: { invalid: true },
      });

      // Should use fallback values
      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-fail',
        status: 'in_progress',
        title: 'failing_tool', // Fallback to tool name
        content: [],
        locations: [], // Fallback to empty
        kind: 'other', // Fallback to other
        rawInput: { invalid: true },
      });
    });
  });

  describe('emitResult', () => {
    it('should emit tool_call_update with completed status on success', async () => {
      await emitter.emitResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: true,
        message: createMockMessage('Tool completed successfully'),
        resultDisplay: 'Tool completed successfully',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-123',
          status: 'completed',
          rawOutput: 'Tool completed successfully',
        }),
      );
    });

    it('should emit tool_call_update with failed status on failure', async () => {
      await emitter.emitResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: false,
        message: [],
        error: new Error('Something went wrong'),
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-123',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Something went wrong' },
          },
        ],
      });
    });

    it('should handle diff display format', async () => {
      await emitter.emitResult({
        toolName: 'edit_file',
        callId: 'call-edit',
        success: true,
        message: [],
        resultDisplay: {
          fileName: '/test/file.ts',
          originalContent: 'old content',
          newContent: 'new content',
        },
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-edit',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/test/file.ts',
              oldText: 'old content',
              newText: 'new content',
            },
          ],
        }),
      );
    });

    it('should transform message parts to content', async () => {
      await emitter.emitResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: true,
        message: [{ text: 'Some text output' }],
        resultDisplay: 'raw output',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-123',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Some text output' },
            },
          ],
          rawOutput: 'raw output',
        }),
      );
    });

    it('should handle empty message parts', async () => {
      await emitter.emitResult({
        toolName: 'test_tool',
        callId: 'call-empty',
        success: true,
        message: [],
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-empty',
        status: 'completed',
        content: [],
      });
    });

    describe('TodoWriteTool handling', () => {
      it('should emit plan update instead of tool_call_update for TodoWriteTool', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: {
            type: 'todo_list',
            todos: [
              { id: '1', content: 'Task 1', status: 'pending' },
              { id: '2', content: 'Task 2', status: 'in_progress' },
            ],
          },
        });

        expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'plan',
          entries: [
            { content: 'Task 1', priority: 'medium', status: 'pending' },
            { content: 'Task 2', priority: 'medium', status: 'in_progress' },
          ],
        });
      });

      it('should use args as fallback for TodoWriteTool todos', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: null,
          args: {
            todos: [{ id: '1', content: 'From args', status: 'completed' }],
          },
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'plan',
          entries: [
            { content: 'From args', priority: 'medium', status: 'completed' },
          ],
        });
      });

      it('should not emit anything for TodoWriteTool with empty todos', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: { type: 'todo_list', todos: [] },
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });

      it('should not emit anything for TodoWriteTool with no extractable todos', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: 'Some string result',
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('emitError', () => {
    it('should emit tool_call_update with failed status and error message', async () => {
      const error = new Error('Connection timeout');

      await emitter.emitError('call-123', error);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-123',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Connection timeout' },
          },
        ],
      });
    });
  });

  describe('isTodoWriteTool', () => {
    it('should return true for TodoWriteTool.Name', () => {
      expect(emitter.isTodoWriteTool(TodoWriteTool.Name)).toBe(true);
    });

    it('should return false for other tool names', () => {
      expect(emitter.isTodoWriteTool('read_file')).toBe(false);
      expect(emitter.isTodoWriteTool('edit_file')).toBe(false);
      expect(emitter.isTodoWriteTool('')).toBe(false);
    });
  });

  describe('mapToolKind', () => {
    it('should map all Kind values correctly', () => {
      expect(emitter.mapToolKind(Kind.Read)).toBe('read');
      expect(emitter.mapToolKind(Kind.Edit)).toBe('edit');
      expect(emitter.mapToolKind(Kind.Delete)).toBe('delete');
      expect(emitter.mapToolKind(Kind.Move)).toBe('move');
      expect(emitter.mapToolKind(Kind.Search)).toBe('search');
      expect(emitter.mapToolKind(Kind.Execute)).toBe('execute');
      expect(emitter.mapToolKind(Kind.Think)).toBe('think');
      expect(emitter.mapToolKind(Kind.Fetch)).toBe('fetch');
      expect(emitter.mapToolKind(Kind.Other)).toBe('other');
    });

    it('should map exit_plan_mode tool to switch_mode kind', () => {
      // exit_plan_mode uses Kind.Think internally, but should map to switch_mode per ACP spec
      expect(emitter.mapToolKind(Kind.Think, 'exit_plan_mode')).toBe(
        'switch_mode',
      );
    });

    it('should not affect other tools with Kind.Think', () => {
      // Other tools with Kind.Think should still map to think
      expect(emitter.mapToolKind(Kind.Think, 'todo_write')).toBe('think');
      expect(emitter.mapToolKind(Kind.Think, 'some_other_tool')).toBe('think');
    });
  });

  describe('isExitPlanModeTool', () => {
    it('should return true for exit_plan_mode tool name', () => {
      expect(emitter.isExitPlanModeTool('exit_plan_mode')).toBe(true);
    });

    it('should return false for other tool names', () => {
      expect(emitter.isExitPlanModeTool('read_file')).toBe(false);
      expect(emitter.isExitPlanModeTool('edit_file')).toBe(false);
      expect(emitter.isExitPlanModeTool('todo_write')).toBe(false);
      expect(emitter.isExitPlanModeTool('')).toBe(false);
    });
  });

  describe('resolveToolMetadata', () => {
    it('should return defaults when tool not found', () => {
      const metadata = emitter.resolveToolMetadata('unknown_tool', {
        arg: 'value',
      });

      expect(metadata).toEqual({
        title: 'unknown_tool',
        locations: [],
        kind: 'other',
      });
    });

    it('should return tool metadata when tool found and built successfully', () => {
      const mockTool = createMockTool({ kind: Kind.Search });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      const metadata = emitter.resolveToolMetadata('search_tool', {
        query: 'test',
      });

      expect(metadata).toEqual({
        title: 'search_tool: Test tool description',
        locations: [{ path: '/test/file.ts', line: 10 }],
        kind: 'search',
      });
    });
  });

  describe('integration: consistent behavior across flows', () => {
    it('should handle the same params consistently regardless of source', async () => {
      // This test verifies that the emitter produces consistent output
      // whether called from normal flow, replay, or subagent

      const params = {
        toolName: 'read_file',
        callId: 'consistent-call',
        args: { path: '/test.ts' },
      };

      // First call (e.g., from normal flow)
      await emitter.emitStart(params);
      const firstCall = sendUpdateSpy.mock.calls[0][0];

      // Reset and call again (e.g., from replay)
      sendUpdateSpy.mockClear();
      await emitter.emitStart(params);
      const secondCall = sendUpdateSpy.mock.calls[0][0];

      // Both should produce identical output
      expect(firstCall).toEqual(secondCall);
    });
  });

  describe('fixes verification', () => {
    describe('Fix 2: functionResponse parts are stringified', () => {
      it('should stringify functionResponse parts in message', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-func',
          success: true,
          message: [
            {
              functionResponse: {
                name: 'test',
                response: { output: 'test output' },
              },
            },
          ],
          resultDisplay: { unknownField: 'value', nested: { data: 123 } },
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-func',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: '{"output":"test output"}',
                },
              },
            ],
            rawOutput: { unknownField: 'value', nested: { data: 123 } },
          }),
        );
      });
    });

    describe('Fix 3: rawOutput is included in emitResult', () => {
      it('should include rawOutput when resultDisplay is provided', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-extra',
          success: true,
          message: [{ text: 'Result text' }],
          resultDisplay: 'Result text',
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-extra',
            status: 'completed',
            rawOutput: 'Result text',
          }),
        );
      });

      it('should not include rawOutput when resultDisplay is undefined', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-null',
          success: true,
          message: [],
        });

        const call = sendUpdateSpy.mock.calls[0][0];
        expect(call.rawOutput).toBeUndefined();
      });
    });

    describe('Fix 5: Line null mapping in resolveToolMetadata', () => {
      it('should map undefined line to null in locations', () => {
        const mockTool = createMockTool();
        // Override toolLocations to return undefined line
        vi.mocked(mockTool.build).mockReturnValue({
          getDescription: () => 'Description',
          toolLocations: () => [
            { path: '/file1.ts', line: 10 },
            { path: '/file2.ts', line: undefined },
            { path: '/file3.ts' }, // no line property
          ],
        } as unknown as AnyToolInvocation);
        vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

        const metadata = emitter.resolveToolMetadata('test_tool', {
          arg: 'value',
        });

        expect(metadata.locations).toEqual([
          { path: '/file1.ts', line: 10 },
          { path: '/file2.ts', line: null },
          { path: '/file3.ts', line: null },
        ]);
      });
    });

    describe('Fix 6: Empty plan emission when args has todos', () => {
      it('should emit empty plan when args had todos but result has none', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo-empty',
          success: true,
          message: [],
          resultDisplay: null, // No result display
          args: {
            todos: [], // Empty array in args
          },
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'plan',
          entries: [],
        });
      });

      it('should emit empty plan when result todos is empty but args had todos', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo-cleared',
          success: true,
          message: [],
          resultDisplay: {
            type: 'todo_list',
            todos: [], // Empty result
          },
          args: {
            todos: [{ id: '1', content: 'Was here', status: 'pending' }],
          },
        });

        // Should still emit empty plan (result takes precedence but we emit empty)
        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'plan',
          entries: [],
        });
      });
    });

    describe('Message transformation', () => {
      it('should transform text parts from message', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-text',
          success: true,
          message: [{ text: 'Text content from message' }],
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-text',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Text content from message' },
            },
          ],
        });
      });

      it('should transform functionResponse parts from message', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-func-resp',
          success: true,
          message: [
            {
              functionResponse: {
                name: 'test_tool',
                response: { output: 'Function output' },
              },
            },
          ],
          resultDisplay: 'raw result',
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-func-resp',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: '{"output":"Function output"}' },
              },
            ],
            rawOutput: 'raw result',
          }),
        );
      });
    });
  });
});
