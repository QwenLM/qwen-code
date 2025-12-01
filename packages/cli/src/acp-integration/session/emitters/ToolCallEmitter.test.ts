/**
 * @license
 * Copyright 2025 Google LLC
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
        title: 'Test tool description',
        content: [],
        locations: [{ path: '/test/file.ts', line: 10 }],
        kind: 'edit',
        rawInput: { path: '/test.ts' },
      });
    });

    it('should use description override when provided', async () => {
      const mockTool = createMockTool();
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      await emitter.emitStart({
        toolName: 'test_tool',
        callId: 'call-789',
        args: {},
        description: 'Custom description from subagent',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Custom description from subagent',
        }),
      );
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
        resultDisplay: 'Tool completed successfully',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-123',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Tool completed successfully' },
          },
        ],
      });
    });

    it('should emit tool_call_update with failed status on failure', async () => {
      await emitter.emitResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: false,
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
        resultDisplay: {
          fileName: '/test/file.ts',
          originalContent: 'old content',
          newContent: 'new content',
        },
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
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
      });
    });

    it('should handle plan_summary display format', async () => {
      await emitter.emitResult({
        toolName: 'plan_tool',
        callId: 'call-plan',
        success: true,
        resultDisplay: {
          type: 'plan_summary',
          message: 'Plan created',
          plan: 'Step 1\nStep 2',
        },
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-plan',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Plan created\n\nStep 1\nStep 2' },
          },
        ],
      });
    });

    it('should handle empty result display', async () => {
      await emitter.emitResult({
        toolName: 'test_tool',
        callId: 'call-empty',
        success: true,
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
          resultDisplay: { type: 'todo_list', todos: [] },
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });

      it('should not emit anything for TodoWriteTool with no extractable todos', async () => {
        await emitter.emitResult({
          toolName: TodoWriteTool.Name,
          callId: 'call-todo',
          success: true,
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

    it('should use description override when provided', () => {
      const mockTool = createMockTool();
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      const metadata = emitter.resolveToolMetadata(
        'test_tool',
        { arg: 'value' },
        'Override description',
      );

      expect(metadata.title).toBe('Override description');
    });

    it('should return tool metadata when tool found and built successfully', () => {
      const mockTool = createMockTool({ kind: Kind.Search });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      const metadata = emitter.resolveToolMetadata('search_tool', {
        query: 'test',
      });

      expect(metadata).toEqual({
        title: 'Test tool description',
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
    describe('Fix 2: JSON.stringify fallback for unknown objects', () => {
      it('should JSON.stringify unknown object types in resultDisplay', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-unknown',
          success: true,
          resultDisplay: { unknownField: 'value', nested: { data: 123 } },
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-unknown',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: '{"unknownField":"value","nested":{"data":123}}',
              },
            },
          ],
        });
      });
    });

    describe('Fix 3: Extra fields in emitResult for SubAgentTracker', () => {
      it('should include extra fields when provided', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-extra',
          success: true,
          resultDisplay: 'Result text',
          extra: {
            title: 'Custom title',
            kind: 'edit',
            locations: [{ path: '/file.ts', line: 5 }],
            rawInput: { arg: 'value' },
          },
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-extra',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'Result text' } },
          ],
          title: 'Custom title',
          kind: 'edit',
          locations: [{ path: '/file.ts', line: 5 }],
          rawInput: { arg: 'value' },
        });
      });

      it('should handle null values in extra fields', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-null',
          success: true,
          extra: {
            title: 'Title',
            kind: null,
            locations: null,
          },
        });

        const call = sendUpdateSpy.mock.calls[0][0];
        expect(call.title).toBe('Title');
        expect(call.kind).toBeNull();
        expect(call.locations).toBeNull();
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

    describe('Fallback content', () => {
      it('should use fallbackContent when resultDisplay is not available', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-fallback',
          success: true,
          resultDisplay: undefined,
          fallbackContent: 'Fallback text from message',
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-fallback',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Fallback text from message' },
            },
          ],
        });
      });

      it('should prefer resultDisplay over fallbackContent', async () => {
        await emitter.emitResult({
          toolName: 'test_tool',
          callId: 'call-prefer',
          success: true,
          resultDisplay: 'Primary content',
          fallbackContent: 'Fallback content',
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-prefer',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Primary content' },
            },
          ],
        });
      });
    });
  });
});
