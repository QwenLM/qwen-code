/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HistoryReplayer } from './HistoryReplayer.js';
import type { SessionContext } from './types.js';
import type {
  Config,
  ChatRecord,
  ToolRegistry,
  ToolResultDisplay,
  TodoResultDisplay,
} from '@qwen-code/qwen-code-core';

describe('HistoryReplayer', () => {
  let mockContext: SessionContext;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let replayer: HistoryReplayer;

  beforeEach(() => {
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
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

    replayer = new HistoryReplayer(mockContext);
  });

  const createUserRecord = (text: string): ChatRecord => ({
    uuid: 'user-uuid',
    parentUuid: null,
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'user',
    cwd: '/test',
    version: '1.0.0',
    message: {
      role: 'user',
      parts: [{ text }],
    },
  });

  const createAssistantRecord = (
    text: string,
    thought = false,
  ): ChatRecord => ({
    uuid: 'assistant-uuid',
    parentUuid: 'user-uuid',
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'assistant',
    cwd: '/test',
    version: '1.0.0',
    message: {
      role: 'model',
      parts: [{ text, thought }],
    },
  });

  const createToolResultRecord = (
    toolName: string,
    resultDisplay?: ToolResultDisplay,
    hasError = false,
  ): ChatRecord => ({
    uuid: 'tool-uuid',
    parentUuid: 'assistant-uuid',
    sessionId: 'test-session',
    timestamp: new Date().toISOString(),
    type: 'tool_result',
    cwd: '/test',
    version: '1.0.0',
    message: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: toolName,
            response: { result: 'ok' },
          },
        },
      ],
    },
    toolCallResult: {
      callId: 'call-123',
      responseParts: [],
      resultDisplay,
      error: hasError ? new Error('Tool failed') : undefined,
      errorType: undefined,
    },
  });

  describe('replay', () => {
    it('should replay empty records array', async () => {
      await replayer.replay([]);

      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });

    it('should replay records in order', async () => {
      const records = [
        createUserRecord('Hello'),
        createAssistantRecord('Hi there'),
      ];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledTimes(2);
      expect(sendUpdateSpy.mock.calls[0][0].sessionUpdate).toBe(
        'user_message_chunk',
      );
      expect(sendUpdateSpy.mock.calls[1][0].sessionUpdate).toBe(
        'agent_message_chunk',
      );
    });
  });

  describe('user message replay', () => {
    it('should emit user_message_chunk for user records', async () => {
      const records = [createUserRecord('Hello, world!')];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Hello, world!' },
      });
    });

    it('should skip user records without message', async () => {
      const record: ChatRecord = {
        ...createUserRecord('test'),
        message: undefined,
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });
  });

  describe('assistant message replay', () => {
    it('should emit agent_message_chunk for assistant records', async () => {
      const records = [createAssistantRecord('I can help with that.')];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I can help with that.' },
      });
    });

    it('should emit agent_thought_chunk for thought parts', async () => {
      const records = [createAssistantRecord('Thinking about this...', true)];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking about this...' },
      });
    });

    it('should handle assistant records with multiple parts', async () => {
      const record: ChatRecord = {
        ...createAssistantRecord('First'),
        message: {
          role: 'model',
          parts: [
            { text: 'First part' },
            { text: 'Second part', thought: true },
            { text: 'Third part' },
          ],
        },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledTimes(3);
      expect(sendUpdateSpy.mock.calls[0][0]).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'First part' },
      });
      expect(sendUpdateSpy.mock.calls[1][0]).toEqual({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Second part' },
      });
      expect(sendUpdateSpy.mock.calls[2][0]).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Third part' },
      });
    });
  });

  describe('function call replay', () => {
    it('should emit tool_call for function call parts', async () => {
      const record: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'read_file',
                args: { path: '/test.ts' },
              },
            },
          ],
        },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call',
          status: 'in_progress',
          title: 'read_file',
          rawInput: { path: '/test.ts' },
        }),
      );
    });

    it('should use function call id as callId when available', async () => {
      const record: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'custom-call-id',
                name: 'read_file',
                args: {},
              },
            },
          ],
        },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'custom-call-id',
        }),
      );
    });
  });

  describe('tool result replay', () => {
    it('should emit tool_call_update for tool result records', async () => {
      const records = [
        createToolResultRecord('read_file', 'File contents here'),
      ];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-123',
        status: 'completed',
        content: [
          {
            type: 'content',
            // Content comes from functionResponse.response (stringified)
            content: { type: 'text', text: '{"result":"ok"}' },
          },
        ],
        // resultDisplay is included as rawOutput
        rawOutput: 'File contents here',
      });
    });

    it('should emit failed status for tool results with errors', async () => {
      const records = [createToolResultRecord('failing_tool', undefined, true)];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          status: 'failed',
        }),
      );
    });

    it('should emit plan update for TodoWriteTool results', async () => {
      const todoDisplay: TodoResultDisplay = {
        type: 'todo_list',
        todos: [
          { id: '1', content: 'Task 1', status: 'pending' },
          { id: '2', content: 'Task 2', status: 'completed' },
        ],
      };
      const record = createToolResultRecord('todo_write', todoDisplay);
      // Override the function response name
      record.message = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'todo_write',
              response: { result: 'ok' },
            },
          },
        ],
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Task 1', priority: 'medium', status: 'pending' },
          { content: 'Task 2', priority: 'medium', status: 'completed' },
        ],
      });
    });

    it('should use record uuid as callId when toolCallResult.callId is missing', async () => {
      const record: ChatRecord = {
        ...createToolResultRecord('test_tool'),
        uuid: 'fallback-uuid',
        toolCallResult: {
          callId: undefined as unknown as string,
          responseParts: [],
          resultDisplay: 'Result',
          error: undefined,
          errorType: undefined,
        },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'fallback-uuid',
        }),
      );
    });
  });

  describe('system records', () => {
    it('should skip system records', async () => {
      const systemRecord: ChatRecord = {
        uuid: 'system-uuid',
        parentUuid: null,
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        type: 'system',
        subtype: 'chat_compression',
        cwd: '/test',
        version: '1.0.0',
      };

      await replayer.replay([systemRecord]);

      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });
  });

  describe('mixed record types', () => {
    it('should handle a complete conversation replay', async () => {
      const records: ChatRecord[] = [
        createUserRecord('Read the file test.ts'),
        {
          ...createAssistantRecord(''),
          message: {
            role: 'model',
            parts: [
              { text: "I'll read that file for you.", thought: true },
              {
                functionCall: {
                  id: 'call-read',
                  name: 'read_file',
                  args: { path: 'test.ts' },
                },
              },
            ],
          },
        },
        createToolResultRecord('read_file', 'export const x = 1;'),
        createAssistantRecord('The file contains a simple export.'),
      ];

      await replayer.replay(records);

      // Verify order and types of updates
      const updateTypes = sendUpdateSpy.mock.calls.map(
        (call: unknown[]) =>
          (call[0] as { sessionUpdate: string }).sessionUpdate,
      );
      expect(updateTypes).toEqual([
        'user_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
        'agent_message_chunk',
      ]);
    });
  });
});
