/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolCallEmitter } from './tool-call-emitter.js';
import type {
  SessionContext,
  SessionEmitterContext,
  SubagentMeta,
} from '../types.js';
import type {
  Config,
  ToolRegistry,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '@qwen-code/qwen-code-core';
import { Kind, ToolNames } from '@qwen-code/qwen-code-core';
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
        status: 'pending',
        title: 'unknown_tool', // Falls back to tool name
        content: [],
        locations: [],
        kind: 'other',
        rawInput: { arg1: 'value1' },
        _meta: { toolName: 'unknown_tool', provenance: 'builtin' },
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
        status: 'pending',
        title: 'edit_file: Test tool description',
        content: [],
        locations: [{ path: '/test/file.ts', line: 10 }],
        kind: 'edit',
        rawInput: { path: '/test.ts' },
        _meta: { toolName: 'edit_file', provenance: 'builtin' },
      });
    });

    it('should skip emit for TodoWriteTool and return false', async () => {
      const result = await emitter.emitStart({
        toolName: ToolNames.TODO_WRITE,
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
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
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
        status: 'pending',
        title: 'failing_tool', // Fallback to tool name
        content: [],
        locations: [], // Fallback to empty
        kind: 'other', // Fallback to other
        rawInput: { invalid: true },
        _meta: { toolName: 'failing_tool', provenance: 'builtin' },
      });
    });
  });

  describe('tool preparation lifecycle', () => {
    it('emits a preparing tool call without partial input', async () => {
      await emitter.emitStart({
        callId: 'call-1',
        toolName: 'read_file',
        args: {},
        status: 'pending',
        phase: 'preparing',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          status: 'pending',
          rawInput: {},
          _meta: expect.objectContaining({
            toolName: 'read_file',
            phase: 'preparing',
          }),
        }),
      );
    });

    it('suppresses duplicate preparing frames for the same call ID', async () => {
      const params = {
        callId: 'call-1',
        toolName: 'read_file',
        args: {},
        status: 'pending' as const,
        phase: 'preparing' as const,
      };

      const first = await emitter.emitStart(params);
      const duplicate = await emitter.emitStart(params);

      expect(first).toBe(true);
      expect(duplicate).toBe(false);
      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
    });

    it('updates the prepared tool call when execution starts', async () => {
      await emitter.emitStart({
        callId: 'call-1',
        toolName: 'read_file',
        args: {},
        status: 'pending',
        phase: 'preparing',
      });
      await emitter.emitStart({
        callId: 'call-1',
        toolName: 'read_file',
        args: { file_path: 'README.md' },
        status: 'in_progress',
      });

      expect(sendUpdateSpy.mock.calls.map(([update]) => update)).toEqual([
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          toolCallId: 'call-1',
          _meta: expect.objectContaining({ phase: 'preparing' }),
        }),
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'in_progress',
          rawInput: { file_path: 'README.md' },
        }),
      ]);
    });

    it('emits a protocol-valid discarded preparation terminal update', async () => {
      await emitter.emitPreparationDiscarded(
        'call-1',
        'mcp__filesystem__read_file',
      );

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'failed',
        content: [],
        _meta: {
          toolName: 'mcp__filesystem__read_file',
          phase: 'preparing',
          preparationDiscarded: true,
          provenance: 'mcp',
          serverId: 'filesystem',
        },
      });
    });

    it.each(['result', 'error'] as const)(
      'clears prepared state after terminal %s',
      async (terminal) => {
        const preparation = {
          callId: 'call-1',
          toolName: 'read_file',
          args: {},
          status: 'pending' as const,
          phase: 'preparing' as const,
        };
        await emitter.emitStart(preparation);

        if (terminal === 'result') {
          await emitter.emitResult({
            callId: 'call-1',
            toolName: 'read_file',
            success: true,
            message: [],
          });
        } else {
          await emitter.emitError('call-1', 'read_file', new Error('failed'));
        }
        sendUpdateSpy.mockClear();

        const emitted = await emitter.emitStart(preparation);

        expect(emitted).toBe(true);
        expect(sendUpdateSpy).toHaveBeenCalledOnce();
        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call',
            toolCallId: 'call-1',
            _meta: expect.objectContaining({ phase: 'preparing' }),
          }),
        );
      },
    );

    it('suppresses preparation lifecycle frames for TodoWrite', async () => {
      const emitted = await emitter.emitStart({
        callId: 'call-todo',
        toolName: ToolNames.TODO_WRITE,
        args: {},
        status: 'pending',
        phase: 'preparing',
      });
      await emitter.emitPreparationDiscarded('call-todo', ToolNames.TODO_WRITE);

      expect(emitted).toBe(false);
      expect(sendUpdateSpy).not.toHaveBeenCalled();
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
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
        }),
      );
    });

    it('places the vision bridge disclosure in ACP content on success', async () => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: 'Transcribed PDF pages 20-23; remaining pages 24-25',
        notice:
          'Converted 4 images via qwen3-vl-plus (dashscope.aliyuncs.com).',
      };

      await emitter.emitResult({
        toolName: 'read_file',
        callId: 'call-pdf-success',
        success: true,
        message: createMockMessage('Page 20: transcribed content'),
        resultDisplay,
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `${resultDisplay.summary}\n${resultDisplay.notice}`,
              },
            },
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Page 20: transcribed content',
              },
            },
          ],
          rawOutput: resultDisplay,
        }),
      );
    });

    it('sanitizes terminal controls in the ACP vision bridge disclosure', async () => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: 'Transcribed evil\x1b]52;c;ZXZpbA==\x07\u202E.pdf pages 20-23',
        notice: 'Converted via qwen3-vl-plus.',
      };

      await emitter.emitResult({
        toolName: 'read_file',
        callId: 'call-pdf-unsafe-name',
        success: true,
        message: createMockMessage('Page 20: transcribed content'),
        resultDisplay,
      });

      const update = sendUpdateSpy.mock.calls[0][0] as {
        content: Array<{ content?: { text?: string } }>;
      };
      const disclosure = update.content[0].content?.text;
      expect(disclosure).toContain('evil');
      expect(disclosure).not.toContain('\x1b');
      expect(disclosure).not.toContain('\x07');
      expect(disclosure).not.toContain('\u202e');
    });

    it('keeps the vision bridge disclosure in ACP content on failure', async () => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: 'Failed to read PDF after rendering pages 20-23',
        notice:
          'Vision bridge (qwen3-vl-plus) failed after sending images to dashscope.aliyuncs.com.',
      };

      await emitter.emitResult({
        toolName: 'read_file',
        callId: 'call-pdf-failure',
        success: false,
        message: createMockMessage('Cannot extract text from PDF'),
        resultDisplay,
        error: new Error('No extractable text layer.'),
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `${resultDisplay.summary}\n${resultDisplay.notice}`,
              },
            },
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'No extractable text layer.',
              },
            },
          ],
          rawOutput: resultDisplay,
        }),
      );
    });

    it('emits structured artifacts without a wire trust marker', async () => {
      await emitter.emitResult({
        toolName: ToolNames.ARTIFACT,
        callId: 'call-artifact',
        success: true,
        message: createMockMessage('Published'),
        artifacts: [
          {
            kind: 'html',
            storage: 'published',
            title: 'Dashboard',
            url: 'file:///tmp/dashboard.html',
            managedId: 'managed-1',
          },
        ],
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-artifact',
          status: 'completed',
          _meta: expect.objectContaining({
            toolName: ToolNames.ARTIFACT,
            artifacts: [
              expect.objectContaining({
                title: 'Dashboard',
                storage: 'published',
              }),
            ],
          }),
        }),
      );
      expect(
        (
          sendUpdateSpy.mock.calls[0]?.[0] as {
            _meta?: Record<string, unknown>;
          }
        )._meta,
      ).not.toHaveProperty('artifactsTrustedPublisher');
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
        _meta: { toolName: 'test_tool', provenance: 'builtin' },
      });
    });

    it('emits structured artifacts from failed tool results', async () => {
      await emitter.emitResult({
        toolName: ToolNames.RECORD_ARTIFACT,
        callId: 'call-failed-artifact',
        success: false,
        message: [],
        error: new Error('record failed'),
        artifacts: [
          { title: 'Failure report', url: 'https://example.com/drop' },
        ],
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-failed-artifact',
          status: 'failed',
          _meta: expect.objectContaining({
            artifacts: [
              expect.objectContaining({
                title: 'Failure report',
                url: 'https://example.com/drop',
              }),
            ],
          }),
        }),
      );
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
          _meta: { toolName: 'edit_file', provenance: 'builtin' },
        }),
      );
      expect(sendUpdateSpy.mock.calls[0][0].rawOutput).toEqual({
        fileName: '/test/file.ts',
        originalContent: 'old content',
        newContent: 'new content',
      });
    });

    it('should not replay truncated session previews as full diffs', async () => {
      await emitter.emitResult({
        toolName: 'edit_file',
        callId: 'call-edit',
        success: true,
        message: [],
        resultDisplay: {
          fileName: '/test/file.ts',
          originalContent: 'old preview',
          newContent: 'new preview',
          truncatedForSession: true,
          fileDiffLength: 200000,
          fileDiffTruncated: true,
        },
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-edit',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Full diff omitted from saved session history for /test/file.ts. Original fileDiff length: 200000 chars.',
              },
            },
          ],
          _meta: { toolName: 'edit_file', provenance: 'builtin' },
        }),
      );
      expect(sendUpdateSpy.mock.calls[0][0].rawOutput).toBeUndefined();
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
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
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
        _meta: { toolName: 'test_tool', provenance: 'builtin' },
      });
    });

    describe('TodoWriteTool handling', () => {
      it('should emit plan update instead of tool_call_update for TodoWriteTool', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: {
            type: 'todo_list',
            planId: 'plan-1',
            todos: [
              { id: '1', content: 'Task 1', status: 'pending' },
              {
                id: '2',
                content: 'Task 2',
                status: 'in_progress',
                blockedBy: ['1'],
              },
            ],
          },
        });

        expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'plan',
          entries: [
            {
              content: 'Task 1',
              priority: 'medium',
              status: 'pending',
              _meta: { qwenTodo: { id: '1' } },
            },
            {
              content: 'Task 2',
              priority: 'medium',
              status: 'in_progress',
              _meta: { qwenTodo: { id: '2', blockedBy: ['1'] } },
            },
          ],
          _meta: {
            qwenTodoPlan: { id: 'plan-1' },
            qwenTranscript: { planToolCallId: 'call-todo' },
          },
        });
      });

      it('should use args as fallback for TodoWriteTool todos', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
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
            {
              content: 'From args',
              priority: 'medium',
              status: 'completed',
              _meta: { qwenTodo: { id: '1' } },
            },
          ],
          _meta: { qwenTranscript: { planToolCallId: 'call-todo' } },
        });
      });

      it('should not emit anything for TodoWriteTool with empty todos', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: { type: 'todo_list', todos: [] },
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });

      it('should not emit anything for TodoWriteTool with no extractable todos', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
          callId: 'call-todo',
          success: true,
          message: [],
          resultDisplay: 'Some string result',
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });

      it('should not publish rejected TodoWrite arguments as a plan', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
          callId: 'call-invalid-todo',
          success: true,
          message: [],
          resultDisplay:
            'Error writing todos: dependency graph contains a cycle',
          args: {
            todos: [
              {
                id: 'a',
                content: 'Invalid cycle',
                status: 'pending',
                blockedBy: ['a'],
              },
            ],
          },
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });

      it('does not promote a subagent TodoWrite as the session plan', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
          callId: 'call-subagent-todo',
          success: true,
          message: [],
          resultDisplay: {
            type: 'todo_list',
            todos: [{ id: '1', content: 'Child task', status: 'pending' }],
          },
          subagentMeta: {
            parentToolCallId: 'parent-agent',
            subagentType: 'explore',
          },
        });

        expect(sendUpdateSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('emitError', () => {
    it('should emit tool_call_update with failed status and error message', async () => {
      const error = new Error('Connection timeout');

      await emitter.emitError('call-123', 'test_tool', error);

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
        _meta: { toolName: 'test_tool', provenance: 'builtin' },
      });
    });
  });

  describe('isTodoWriteTool', () => {
    it('should return true for ToolNames.TODO_WRITE', () => {
      expect(emitter.isTodoWriteTool(ToolNames.TODO_WRITE)).toBe(true);
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
      // Kind.Agent maps to 'other' on the wire: ACP has no 'agent' ToolKind,
      // so emitting it would be Zod-rejected at the daemon's ACP boundary.
      expect(emitter.mapToolKind(Kind.Agent)).toBe('other');
      expect(emitter.mapToolKind(Kind.Other)).toBe('other');
    });

    it('should map exit_plan_mode tool to switch_mode kind', () => {
      // exit_plan_mode uses Kind.Think internally, but should map to switch_mode per ACP spec
      expect(emitter.mapToolKind(Kind.Think, 'exit_plan_mode')).toBe(
        'switch_mode',
      );
    });

    it('should map enter_plan_mode tool to switch_mode kind', () => {
      expect(emitter.mapToolKind(Kind.Think, 'enter_plan_mode')).toBe(
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
    it('uses persisted metadata without a Config in direct replay', () => {
      const context: SessionEmitterContext = {
        sessionId: 'persisted-session',
        sendUpdate: vi.fn().mockResolvedValue(undefined),
      };
      const configless = new ToolCallEmitter(context);

      expect(
        configless.resolveToolMetadata('read_file', {
          description: 'Read the persisted file',
          path: '/untrusted/project/file.ts',
        }),
      ).toEqual({
        title: 'read_file: Read the persisted file',
        locations: [],
        kind: 'other',
      });
    });

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
                  text: 'test output',
                },
              },
            ],
            rawOutput: { unknownField: 'value', nested: { data: 123 } },
            _meta: { toolName: 'test_tool', provenance: 'builtin' },
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
            _meta: { toolName: 'test_tool', provenance: 'builtin' },
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
        expect(call._meta).toEqual({
          toolName: 'test_tool',
          provenance: 'builtin',
        });
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
          toolName: ToolNames.TODO_WRITE,
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
          _meta: {
            qwenTranscript: { planToolCallId: 'call-todo-empty' },
          },
        });
      });

      it('should emit empty plan when result todos is empty but args had todos', async () => {
        await emitter.emitResult({
          toolName: ToolNames.TODO_WRITE,
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
          _meta: {
            qwenTranscript: { planToolCallId: 'call-todo-cleared' },
          },
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
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
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
                content: { type: 'text', text: 'Function output' },
              },
            ],
            rawOutput: 'raw result',
            _meta: { toolName: 'test_tool', provenance: 'builtin' },
          }),
        );
      });
    });
  });

  describe('resolveToolProvenance (#4175 F4 prereq, chiga0 #19 P0)', () => {
    // Pure static utility — exercise without an emitter instance.
    it('classifies a plain tool name as builtin (no serverId)', () => {
      const out = ToolCallEmitter.resolveToolProvenance('shell');
      expect(out).toEqual({ provenance: 'builtin' });
    });

    it('classifies a tool name without mcp__ prefix as builtin', () => {
      const out = ToolCallEmitter.resolveToolProvenance('read_file');
      expect(out).toEqual({ provenance: 'builtin' });
    });

    it('classifies mcp__<server>__<tool> as mcp with serverId', () => {
      const out = ToolCallEmitter.resolveToolProvenance(
        'mcp__filesystem__read',
      );
      expect(out).toEqual({ provenance: 'mcp', serverId: 'filesystem' });
    });

    it('preserves underscores in the tool segment', () => {
      // Server segment is `playwright`; tool segment is `take_screenshot`
      // (with underscore inside the tool name — `split("__")` handles
      // this because we split on the double-underscore delimiter).
      const out = ToolCallEmitter.resolveToolProvenance(
        'mcp__playwright__take_screenshot',
      );
      expect(out).toEqual({ provenance: 'mcp', serverId: 'playwright' });
    });

    it('classifies malformed mcp__ prefix (only one segment) as builtin', () => {
      // No double-underscore delimiter past the prefix → not a valid
      // mcp tool name; fall back to builtin rather than stamping
      // garbage serverId.
      const out = ToolCallEmitter.resolveToolProvenance('mcp__just_one');
      expect(out).toEqual({ provenance: 'builtin' });
    });

    it('classifies mcp__<empty>__<tool> as builtin (empty server segment)', () => {
      const out = ToolCallEmitter.resolveToolProvenance('mcp____read');
      expect(out).toEqual({ provenance: 'builtin' });
    });

    it('classifies any tool as subagent when subagentMeta is present', () => {
      // subagent takes precedence over mcp__ naming — a sub-agent
      // calling an MCP tool is rendered as "subagent block" not
      // "MCP block" in the UI.
      const out = ToolCallEmitter.resolveToolProvenance('mcp__fs__read', {
        agentType: 'researcher',
      } as unknown as SubagentMeta);
      expect(out).toEqual({ provenance: 'subagent' });
    });

    it('classifies a plain builtin tool with subagentMeta as subagent', () => {
      const out = ToolCallEmitter.resolveToolProvenance('shell', {
        agentType: 'coder',
      } as unknown as SubagentMeta);
      expect(out).toEqual({ provenance: 'subagent' });
    });
  });

  describe('provenance stamping on emit (#4175 F4 prereq)', () => {
    it('stamps provenance:mcp + serverId on emitStart for mcp__ tools', async () => {
      await emitter.emitStart({
        toolName: 'mcp__github__create_issue',
        callId: 'call-mcp',
        args: { title: 'bug' },
      });
      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          _meta: expect.objectContaining({
            toolName: 'mcp__github__create_issue',
            provenance: 'mcp',
            serverId: 'github',
          }),
        }),
      );
    });

    it('stamps provenance:subagent (no serverId) when subagentMeta present', async () => {
      await emitter.emitStart({
        toolName: 'shell',
        callId: 'call-sub',
        args: {},
        subagentMeta: { agentType: 'researcher' } as unknown as SubagentMeta,
      });
      const call = sendUpdateSpy.mock.calls[0][0];
      expect(call._meta.provenance).toBe('subagent');
      expect(call._meta.serverId).toBeUndefined();
    });

    it('stamps provenance on emitResult so reconnecting clients can re-derive it', async () => {
      await emitter.emitResult({
        toolName: 'mcp__db__query',
        callId: 'call-r',
        success: true,
        message: [],
      });
      const call = sendUpdateSpy.mock.calls[0][0];
      expect(call._meta.provenance).toBe('mcp');
      expect(call._meta.serverId).toBe('db');
    });

    it('stamps provenance on emitError as well', async () => {
      await emitter.emitError('call-e', 'mcp__fs__write', new Error('boom'));
      const call = sendUpdateSpy.mock.calls[0][0];
      expect(call._meta.provenance).toBe('mcp');
      expect(call._meta.serverId).toBe('fs');
    });
  });
});
