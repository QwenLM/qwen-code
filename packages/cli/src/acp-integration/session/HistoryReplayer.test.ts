/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  HistoryReplayer,
  MISSING_TOOL_RESULT_MESSAGE,
} from './HistoryReplayer.js';
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
  let setActiveRecordIdSpy: ReturnType<typeof vi.fn>;
  let sentUpdateContexts: Array<{
    activeRecordId: string | null;
    activeRecordTimestamp: string | undefined;
  }>;
  let replayer: HistoryReplayer;

  beforeEach(() => {
    let activeRecordId: string | null = null;
    let activeRecordTimestamp: string | undefined;
    sentUpdateContexts = [];
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    setActiveRecordIdSpy = vi.fn((id: string | null, timestamp?: string) => {
      activeRecordId = id;
      activeRecordTimestamp = timestamp;
    });
    const mockToolRegistry = {
      getTool: vi.fn().mockReturnValue(null),
    } as unknown as ToolRegistry;

    mockContext = {
      sessionId: 'test-session-id',
      config: {
        getToolRegistry: () => mockToolRegistry,
      } as unknown as Config,
      sendUpdate: vi.fn(async (update) => {
        sentUpdateContexts.push({ activeRecordId, activeRecordTimestamp });
        await sendUpdateSpy(update);
      }),
      setActiveRecordId: setActiveRecordIdSpy,
    } as unknown as SessionContext;

    replayer = new HistoryReplayer(mockContext);
  });

  const toEpochMs = (ts: string) => new Date(ts).getTime();
  const sentUpdates = () =>
    sendUpdateSpy.mock.calls.map(
      (call: unknown[]) => call[0] as Record<string, unknown>,
    );

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
      const record = createUserRecord('Hello, world!');
      const records = [record];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Hello, world!' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
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

    it('should replay mid-turn user messages using display text', async () => {
      const record: ChatRecord = {
        ...createUserRecord(
          '\n[User message received during tool execution]: save logs',
        ),
        subtype: 'mid_turn_user_message',
        systemPayload: { displayText: 'save logs' },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'save logs' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
      });
    });
  });

  describe('assistant message replay', () => {
    it('should emit agent_message_chunk for assistant records', async () => {
      const record = createAssistantRecord('I can help with that.');
      const records = [record];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'I can help with that.' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
      });
    });

    it('should emit agent_thought_chunk for thought parts', async () => {
      const record = createAssistantRecord('Thinking about this...', true);
      const records = [record];

      await replayer.replay(records);

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking about this...' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
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
        _meta: { timestamp: toEpochMs(record.timestamp) },
      });
      expect(sendUpdateSpy.mock.calls[1][0]).toEqual({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Second part' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
      });
      expect(sendUpdateSpy.mock.calls[2][0]).toEqual({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Third part' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
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
          _meta: {
            toolName: 'read_file',
            // #4175 F4 prereq — ToolCallEmitter now stamps provenance
            // on every tool_call / tool_call_update event so the UI can
            // dispatch on builtin / mcp / subagent without string-
            // matching toolName.
            provenance: 'builtin',
            timestamp: toEpochMs(record.timestamp),
          },
        }),
      );
      expect(sendUpdateSpy).toHaveBeenCalledTimes(1);
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

    it('should fail dangling function calls after replay completes', async () => {
      const record: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-missing',
                name: 'run_shell_command',
                args: { command: 'sleep 10' },
              },
            },
          ],
        },
      };

      await replayer.replay([record]);

      const updates = sentUpdates();
      expect(updates.map((update) => update['sessionUpdate'])).toEqual([
        'tool_call',
        'tool_call_update',
      ]);
      expect(updates[1]).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-missing',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: MISSING_TOOL_RESULT_MESSAGE,
            },
          },
        ],
        _meta: {
          toolName: 'run_shell_command',
          provenance: 'builtin',
          timestamp: toEpochMs(record.timestamp),
        },
      });
      expect(setActiveRecordIdSpy).toHaveBeenCalledWith(
        record.uuid,
        record.timestamp,
      );
      expect(sentUpdateContexts[1]).toEqual({
        activeRecordId: record.uuid,
        activeRecordTimestamp: record.timestamp,
      });
    });

    it('should not synthesize missing-result failures for calls without source ids', async () => {
      const records: ChatRecord[] = [
        {
          ...createAssistantRecord(''),
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'read_file',
                  args: { path: 'test.ts' },
                },
              },
            ],
          },
        },
        createToolResultRecord('read_file', 'File contents here'),
      ];

      await replayer.replay(records);

      const updates = sentUpdates();
      expect(updates.map((update) => update['sessionUpdate'])).toEqual([
        'tool_call',
        'tool_call_update',
      ]);
      expect(updates[1]).toMatchObject({
        toolCallId: 'call-123',
        status: 'completed',
      });
    });

    it('should fail dangling calls before rethrowing replay errors', async () => {
      const danglingRecord: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-missing',
                name: 'run_shell_command',
                args: { command: 'sleep 10' },
              },
            },
          ],
        },
      };
      const failingRecord = createUserRecord('this send fails');
      sendUpdateSpy.mockImplementation(
        async (update: Record<string, unknown>) => {
          if (update['sessionUpdate'] === 'user_message_chunk') {
            throw new Error('replay failed');
          }
        },
      );

      await expect(
        replayer.replay([danglingRecord, failingRecord]),
      ).rejects.toThrow('replay failed');

      const updates = sentUpdates();
      expect(updates.map((update) => update['sessionUpdate'])).toEqual([
        'tool_call',
        'user_message_chunk',
        'tool_call_update',
      ]);
      expect(updates[2]).toMatchObject({
        toolCallId: 'call-missing',
        status: 'failed',
      });
    });

    it('should throw dangling errors and continue failing later dangling calls', async () => {
      const record: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-a',
                name: 'read_file',
                args: { path: 'a.ts' },
              },
            },
            {
              functionCall: {
                id: 'call-b',
                name: 'read_file',
                args: { path: 'b.ts' },
              },
            },
          ],
        },
      };
      sendUpdateSpy.mockImplementation(
        async (update: Record<string, unknown>) => {
          if (
            update['sessionUpdate'] === 'tool_call_update' &&
            update['toolCallId'] === 'call-a'
          ) {
            throw new Error('first synthetic failure failed');
          }
        },
      );

      await expect(replayer.replay([record])).rejects.toThrow(
        'first synthetic failure failed',
      );

      const updates = sentUpdates();
      expect(updates.map((update) => update['sessionUpdate'])).toEqual([
        'tool_call',
        'tool_call',
        'tool_call_update',
        'tool_call_update',
      ]);
      expect(updates[2]).toMatchObject({
        toolCallId: 'call-a',
        status: 'failed',
      });
      expect(updates[3]).toMatchObject({
        toolCallId: 'call-b',
        status: 'failed',
      });
    });

    it('should aggregate replay and dangling cleanup errors', async () => {
      const danglingRecord: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-missing',
                name: 'run_shell_command',
                args: { command: 'sleep 10' },
              },
            },
          ],
        },
      };
      const failingRecord = createUserRecord('this send fails');
      sendUpdateSpy.mockImplementation(
        async (update: Record<string, unknown>) => {
          if (update['sessionUpdate'] === 'user_message_chunk') {
            throw new Error('replay failed');
          }
          if (update['sessionUpdate'] === 'tool_call_update') {
            throw new Error('dangling cleanup failed');
          }
        },
      );

      let caughtError: unknown;
      try {
        await replayer.replay([danglingRecord, failingRecord]);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(AggregateError);
      expect((caughtError as AggregateError).message).toBe(
        'Replay and dangling-cleanup both failed',
      );
      expect(
        (caughtError as AggregateError).errors.map((error) =>
          error instanceof Error ? error.message : String(error),
        ),
      ).toEqual(['replay failed', 'dangling cleanup failed']);
    });

    it('should not fail function calls that have matching tool results', async () => {
      const records: ChatRecord[] = [
        {
          ...createAssistantRecord(''),
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-123',
                  name: 'read_file',
                  args: { path: 'test.ts' },
                },
              },
            ],
          },
        },
        createToolResultRecord('read_file', 'File contents here'),
      ];

      await replayer.replay(records);

      const updates = sentUpdates();
      expect(updates.map((update) => update['sessionUpdate'])).toEqual([
        'tool_call',
        'tool_call_update',
      ]);
      expect(updates[1]).toMatchObject({
        toolCallId: 'call-123',
        status: 'completed',
      });
    });

    it('should only fail dangling calls when matched and dangling calls are mixed', async () => {
      const records: ChatRecord[] = [
        {
          ...createAssistantRecord(''),
          message: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-123',
                  name: 'read_file',
                  args: { path: 'test.ts' },
                },
              },
              {
                functionCall: {
                  id: 'call-missing',
                  name: 'run_shell_command',
                  args: { command: 'sleep 10' },
                },
              },
            ],
          },
        },
        createToolResultRecord('read_file', 'File contents here'),
      ];

      await replayer.replay(records);

      const updates = sentUpdates();
      expect(updates.map((update) => update['sessionUpdate'])).toEqual([
        'tool_call',
        'tool_call',
        'tool_call_update',
        'tool_call_update',
      ]);
      expect(updates[2]).toMatchObject({
        toolCallId: 'call-123',
        status: 'completed',
      });
      expect(updates[3]).toMatchObject({
        toolCallId: 'call-missing',
        status: 'failed',
      });
    });

    it('should not track skipped TodoWrite starts as dangling tool calls', async () => {
      const record: ChatRecord = {
        ...createAssistantRecord(''),
        message: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'todo-call',
                name: 'todo_write',
                args: { todos: [] },
              },
            },
          ],
        },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).not.toHaveBeenCalled();
    });
  });

  describe('tool result replay', () => {
    it('should emit tool_call_update for tool result records', async () => {
      const record = createToolResultRecord('read_file', 'File contents here');
      const records = [record];

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
        _meta: {
          toolName: 'read_file',
          // #4175 F4 prereq — provenance stamped on update events too.
          provenance: 'builtin',
          timestamp: toEpochMs(record.timestamp),
        },
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

    it('should use functionResponse id as callId when toolCallResult.callId is missing', async () => {
      const record: ChatRecord = {
        ...createToolResultRecord('test_tool'),
        uuid: 'fallback-uuid',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'response-call-id',
                name: 'test_tool',
                response: { result: 'ok' },
              },
            },
          ],
        },
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
          toolCallId: 'response-call-id',
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
                  id: 'call-123',
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

  describe('usage metadata replay', () => {
    it('should emit usage metadata after assistant message content', async () => {
      const record: ChatRecord = {
        uuid: 'assistant-uuid',
        parentUuid: 'user-uuid',
        sessionId: 'test-session',
        timestamp: new Date().toISOString(),
        type: 'assistant',
        cwd: '/test',
        version: '1.0.0',
        message: {
          role: 'model',
          parts: [{ text: 'Hello!' }],
        },
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          totalTokenCount: 150,
        },
      };

      await replayer.replay([record]);

      expect(sendUpdateSpy).toHaveBeenCalledTimes(2);
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(1, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello!' },
        _meta: { timestamp: toEpochMs(record.timestamp) },
      });
      expect(sendUpdateSpy).toHaveBeenNthCalledWith(2, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            thoughtTokens: undefined,
            cachedReadTokens: undefined,
          },
        },
      });
    });
  });
});
