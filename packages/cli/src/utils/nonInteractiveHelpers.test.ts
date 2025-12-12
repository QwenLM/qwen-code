/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Config,
  SessionMetrics,
  TaskResultDisplay,
  ToolCallResponseInfo,
} from '@qwen-code/qwen-code-core';
import {
  ToolErrorType,
  MCPServerStatus,
  getMCPServerStatus,
  OutputFormat,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import type {
  CLIUserMessage,
  PermissionMode,
} from '../nonInteractive/types.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import {
  normalizePartList,
  extractPartsFromUserMessage,
  extractUsageFromGeminiClient,
  computeUsageFromMetrics,
  buildSystemMessage,
  createTaskToolProgressHandler,
  functionResponsePartsToString,
  toolResultContent,
} from './nonInteractiveHelpers.js';

// Mock dependencies
vi.mock('../services/CommandService.js', () => ({
  CommandService: {
    create: vi.fn().mockResolvedValue({
      getCommands: vi
        .fn()
        .mockReturnValue([
          { name: 'help' },
          { name: 'commit' },
          { name: 'memory' },
        ]),
    }),
  },
}));

vi.mock('../services/BuiltinCommandLoader.js', () => ({
  BuiltinCommandLoader: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../ui/utils/computeStats.js', () => ({
  computeSessionStats: vi.fn().mockReturnValue({
    totalPromptTokens: 100,
    totalCachedTokens: 20,
  }),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    getMCPServerStatus: vi.fn(),
  };
});

describe('normalizePartList', () => {
  it('should return empty array for null input', () => {
    expect(normalizePartList(null)).toEqual([]);
  });

  it('should return empty array for undefined input', () => {
    expect(normalizePartList(undefined as unknown as null)).toEqual([]);
  });

  it('should convert string to Part array', () => {
    const result = normalizePartList('test string');
    expect(result).toEqual([{ text: 'test string' }]);
  });

  it('should convert array of strings to Part array', () => {
    const result = normalizePartList(['hello', 'world']);
    expect(result).toEqual([{ text: 'hello' }, { text: 'world' }]);
  });

  it('should convert array of mixed strings and Parts to Part array', () => {
    const part: Part = { text: 'existing' };
    const result = normalizePartList(['new', part]);
    expect(result).toEqual([{ text: 'new' }, part]);
  });

  it('should convert single Part object to array', () => {
    const part: Part = { text: 'single part' };
    const result = normalizePartList(part);
    expect(result).toEqual([part]);
  });

  it('should handle empty array', () => {
    expect(normalizePartList([])).toEqual([]);
  });
});

describe('extractPartsFromUserMessage', () => {
  it('should return null for undefined message', () => {
    expect(extractPartsFromUserMessage(undefined)).toBeNull();
  });

  it('should return null for null message', () => {
    expect(
      extractPartsFromUserMessage(null as unknown as undefined),
    ).toBeNull();
  });

  it('should extract string content', () => {
    const message: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: 'test message',
      },
      parent_tool_use_id: null,
    };
    expect(extractPartsFromUserMessage(message)).toBe('test message');
  });

  it('should extract text blocks from content array', () => {
    const message: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      },
      parent_tool_use_id: null,
    };
    const result = extractPartsFromUserMessage(message);
    expect(result).toEqual([{ text: 'hello' }, { text: 'world' }]);
  });

  it('should skip invalid blocks in content array', () => {
    const message: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'valid' },
          null as unknown as { type: 'text'; text: string },
          { type: 'text', text: 'also valid' },
        ],
      },
      parent_tool_use_id: null,
    };
    const result = extractPartsFromUserMessage(message);
    expect(result).toEqual([{ text: 'valid' }, { text: 'also valid' }]);
  });

  it('should convert non-text blocks to JSON strings', () => {
    const message: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'text block' },
          { type: 'tool_use', id: '123', name: 'tool', input: {} },
        ],
      },
      parent_tool_use_id: null,
    };
    const result = extractPartsFromUserMessage(message);
    expect(result).toEqual([
      { text: 'text block' },
      {
        text: JSON.stringify({
          type: 'tool_use',
          id: '123',
          name: 'tool',
          input: {},
        }),
      },
    ]);
  });

  it('should return null for empty content array', () => {
    const message: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: [],
      },
      parent_tool_use_id: null,
    };
    expect(extractPartsFromUserMessage(message)).toBeNull();
  });

  it('should return null when message has no content', () => {
    const message: CLIUserMessage = {
      type: 'user',
      session_id: 'test-session',
      message: {
        role: 'user',
        content: undefined as unknown as string,
      },
      parent_tool_use_id: null,
    };
    expect(extractPartsFromUserMessage(message)).toBeNull();
  });
});

describe('extractUsageFromGeminiClient', () => {
  it('should return undefined for null client', () => {
    expect(extractUsageFromGeminiClient(null)).toBeUndefined();
  });

  it('should return undefined for non-object client', () => {
    expect(extractUsageFromGeminiClient('not an object')).toBeUndefined();
  });

  it('should return undefined when getChat is not a function', () => {
    const client = { getChat: 'not a function' };
    expect(extractUsageFromGeminiClient(client)).toBeUndefined();
  });

  it('should return undefined when chat does not have getDebugResponses', () => {
    const client = {
      getChat: vi.fn().mockReturnValue({}),
    };
    expect(extractUsageFromGeminiClient(client)).toBeUndefined();
  });

  it('should extract usage from latest response with usageMetadata', () => {
    const client = {
      getChat: vi.fn().mockReturnValue({
        getDebugResponses: vi.fn().mockReturnValue([
          { usageMetadata: { promptTokenCount: 50 } },
          {
            usageMetadata: {
              promptTokenCount: 100,
              candidatesTokenCount: 200,
              totalTokenCount: 300,
              cachedContentTokenCount: 10,
            },
          },
        ]),
      }),
    };
    const result = extractUsageFromGeminiClient(client);
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
      cache_read_input_tokens: 10,
    });
  });

  it('should return default values when metadata values are not numbers', () => {
    const client = {
      getChat: vi.fn().mockReturnValue({
        getDebugResponses: vi.fn().mockReturnValue([
          {
            usageMetadata: {
              promptTokenCount: 'not a number',
              candidatesTokenCount: null,
            },
          },
        ]),
      }),
    };
    const result = extractUsageFromGeminiClient(client);
    expect(result).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it('should handle errors gracefully', () => {
    const client = {
      getChat: vi.fn().mockImplementation(() => {
        throw new Error('Test error');
      }),
    };
    const consoleSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const result = extractUsageFromGeminiClient(client);
    expect(result).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should skip responses without usageMetadata', () => {
    const client = {
      getChat: vi.fn().mockReturnValue({
        getDebugResponses: vi.fn().mockReturnValue([
          { someOtherData: 'value' },
          {
            usageMetadata: {
              promptTokenCount: 50,
              candidatesTokenCount: 75,
            },
          },
        ]),
      }),
    };
    const result = extractUsageFromGeminiClient(client);
    expect(result).toEqual({
      input_tokens: 50,
      output_tokens: 75,
    });
  });
});

describe('computeUsageFromMetrics', () => {
  it('should compute usage from SessionMetrics with single model', () => {
    const metrics: SessionMetrics = {
      models: {
        'model-1': {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 50,
            candidates: 100,
            total: 150,
            cached: 10,
            thoughts: 0,
            tool: 0,
          },
        },
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: {
          accept: 0,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {},
      },
      files: {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
    };
    const result = computeUsageFromMetrics(metrics);
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 100,
      cache_read_input_tokens: 20,
      total_tokens: 150,
    });
  });

  it('should aggregate usage across multiple models', () => {
    const metrics: SessionMetrics = {
      models: {
        'model-1': {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 50,
            candidates: 100,
            total: 150,
            cached: 10,
            thoughts: 0,
            tool: 0,
          },
        },
        'model-2': {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 75,
            candidates: 125,
            total: 200,
            cached: 15,
            thoughts: 0,
            tool: 0,
          },
        },
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: {
          accept: 0,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {},
      },
      files: {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
    };
    const result = computeUsageFromMetrics(metrics);
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 225,
      cache_read_input_tokens: 20,
      total_tokens: 350,
    });
  });

  it('should not include total_tokens when it is 0', () => {
    const metrics: SessionMetrics = {
      models: {
        'model-1': {
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 50,
            candidates: 100,
            total: 0,
            cached: 10,
            thoughts: 0,
            tool: 0,
          },
        },
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: {
          accept: 0,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {},
      },
      files: {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
    };
    const result = computeUsageFromMetrics(metrics);
    expect(result).not.toHaveProperty('total_tokens');
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 100,
      cache_read_input_tokens: 20,
    });
  });

  it('should handle empty models', () => {
    const metrics: SessionMetrics = {
      models: {},
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: {
          accept: 0,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {},
      },
      files: {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      },
    };
    const result = computeUsageFromMetrics(metrics);
    expect(result).toEqual({
      input_tokens: 100,
      output_tokens: 0,
      cache_read_input_tokens: 20,
    });
  });
});

describe('buildSystemMessage', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock getMCPServerStatus to return CONNECTED by default
    vi.mocked(getMCPServerStatus).mockReturnValue(MCPServerStatus.CONNECTED);

    mockConfig = {
      getToolRegistry: vi.fn().mockReturnValue({
        getAllToolNames: vi.fn().mockReturnValue(['tool1', 'tool2']),
      }),
      getMcpServers: vi.fn().mockReturnValue({
        'mcp-server-1': {},
        'mcp-server-2': {},
      }),
      getTargetDir: vi.fn().mockReturnValue('/test/dir'),
      getModel: vi.fn().mockReturnValue('test-model'),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getDebugMode: vi.fn().mockReturnValue(false),
    } as unknown as Config;
  });

  it('should build system message with all fields', async () => {
    const result = await buildSystemMessage(
      mockConfig,
      'test-session-id',
      'auto' as PermissionMode,
    );

    expect(result).toEqual({
      type: 'system',
      subtype: 'init',
      uuid: 'test-session-id',
      session_id: 'test-session-id',
      cwd: '/test/dir',
      tools: ['tool1', 'tool2'],
      mcp_servers: [
        { name: 'mcp-server-1', status: 'connected' },
        { name: 'mcp-server-2', status: 'connected' },
      ],
      model: 'test-model',
      permission_mode: 'auto',
      slash_commands: ['commit', 'help', 'memory'],
      qwen_code_version: '1.0.0',
      agents: [],
    });
  });

  it('should handle empty tool registry', async () => {
    const config = {
      ...mockConfig,
      getToolRegistry: vi.fn().mockReturnValue(null),
    } as unknown as Config;

    const result = await buildSystemMessage(
      config,
      'test-session-id',
      'auto' as PermissionMode,
    );

    expect(result.tools).toEqual([]);
  });

  it('should handle empty MCP servers', async () => {
    const config = {
      ...mockConfig,
      getMcpServers: vi.fn().mockReturnValue(null),
    } as unknown as Config;

    const result = await buildSystemMessage(
      config,
      'test-session-id',
      'auto' as PermissionMode,
    );

    expect(result.mcp_servers).toEqual([]);
  });

  it('should use unknown version when getCliVersion returns null', async () => {
    const config = {
      ...mockConfig,
      getCliVersion: vi.fn().mockReturnValue(null),
    } as unknown as Config;

    const result = await buildSystemMessage(
      config,
      'test-session-id',
      'auto' as PermissionMode,
    );

    expect(result.qwen_code_version).toBe('unknown');
  });
});

describe('createTaskToolProgressHandler', () => {
  let mockAdapter: JsonOutputAdapterInterface;
  let mockConfig: Config;

  beforeEach(() => {
    mockConfig = {
      getDebugMode: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
      getOutputFormat: vi.fn().mockReturnValue(OutputFormat.JSON),
    } as unknown as Config;

    mockAdapter = {
      processSubagentToolCall: vi.fn(),
      emitSubagentErrorResult: vi.fn(),
      emitToolResult: vi.fn(),
      emitUserMessage: vi.fn(),
    } as unknown as JsonOutputAdapterInterface;
  });

  it('should create handler that processes task tool calls', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: { arg1: 'value1' },
          status: 'executing',
        },
      ],
    };

    handler('task-call-id', taskDisplay);

    expect(mockAdapter.processSubagentToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'tool-1',
        name: 'test_tool',
        status: 'executing',
      }),
      'parent-tool-id',
    );
  });

  it('should emit tool_result when tool call completes', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: { arg1: 'value1' },
          status: 'success',
          resultDisplay: 'Success result',
        },
      ],
    };

    handler('task-call-id', taskDisplay);

    expect(mockAdapter.emitToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'tool-1',
        name: 'test_tool',
      }),
      expect.objectContaining({
        callId: 'tool-1',
        resultDisplay: 'Success result',
      }),
      'parent-tool-id',
    );
  });

  it('should not duplicate tool_use emissions', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          status: 'executing',
        },
      ],
    };

    // Call handler twice with same tool call
    handler('task-call-id', taskDisplay);
    handler('task-call-id', taskDisplay);

    expect(mockAdapter.processSubagentToolCall).toHaveBeenCalledTimes(1);
  });

  it('should not duplicate tool_result emissions', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          status: 'success',
          resultDisplay: 'Result',
        },
      ],
    };

    // Call handler twice with same completed tool call
    handler('task-call-id', taskDisplay);
    handler('task-call-id', taskDisplay);

    expect(mockAdapter.emitToolResult).toHaveBeenCalledTimes(1);
  });

  it('should handle status transitions from executing to completed', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    // First: executing state
    const executingDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          status: 'executing',
        },
      ],
    };

    // Second: completed state
    const completedDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          status: 'success',
          resultDisplay: 'Done',
        },
      ],
    };

    handler('task-call-id', executingDisplay);
    handler('task-call-id', completedDisplay);

    expect(mockAdapter.processSubagentToolCall).toHaveBeenCalledTimes(1);
    expect(mockAdapter.emitToolResult).toHaveBeenCalledTimes(1);
  });

  it('should emit error result for failed task status', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const runningDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [],
    };

    const failedDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'failed',
      terminateReason: 'Task failed with error',
      toolCalls: [],
    };

    handler('task-call-id', runningDisplay);
    handler('task-call-id', failedDisplay);

    expect(mockAdapter.emitSubagentErrorResult).toHaveBeenCalledWith(
      'Task failed with error',
      0,
      'parent-tool-id',
    );
  });

  it('should emit error result for cancelled task status', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const runningDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [],
    };

    const cancelledDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'cancelled',
      toolCalls: [],
    };

    handler('task-call-id', runningDisplay);
    handler('task-call-id', cancelledDisplay);

    expect(mockAdapter.emitSubagentErrorResult).toHaveBeenCalledWith(
      'Task was cancelled',
      0,
      'parent-tool-id',
    );
  });

  it('should not process non-task-execution displays', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const nonTaskDisplay = {
      type: 'other',
      content: 'some content',
    };

    handler('call-id', nonTaskDisplay as unknown as TaskResultDisplay);

    expect(mockAdapter.processSubagentToolCall).not.toHaveBeenCalled();
    expect(mockAdapter.emitToolResult).not.toHaveBeenCalled();
  });

  it('should handle tool calls with failed status', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          status: 'failed',
          error: 'Tool execution failed',
        },
      ],
    };

    handler('task-call-id', taskDisplay);

    expect(mockAdapter.emitToolResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callId: 'tool-1',
        error: expect.any(Error),
        errorType: ToolErrorType.EXECUTION_FAILED,
      }),
      'parent-tool-id',
    );
  });

  it('should handle tool calls without result content', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      mockAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [
        {
          callId: 'tool-1',
          name: 'test_tool',
          args: {},
          status: 'success',
          resultDisplay: '',
          responseParts: [],
        },
      ],
    };

    handler('task-call-id', taskDisplay);

    // Should not emit tool_result if no content
    expect(mockAdapter.emitToolResult).not.toHaveBeenCalled();
  });

  it('should work without adapter (non-JSON mode)', () => {
    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      undefined,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [],
    };

    // Should not throw
    expect(() => handler('task-call-id', taskDisplay)).not.toThrow();
  });

  it('should work with adapter that does not support subagent APIs', () => {
    const limitedAdapter = {
      emitToolResult: vi.fn(),
    } as unknown as JsonOutputAdapterInterface;

    const { handler } = createTaskToolProgressHandler(
      mockConfig,
      'parent-tool-id',
      limitedAdapter,
    );

    const taskDisplay: TaskResultDisplay = {
      type: 'task_execution',
      subagentName: 'test-agent',
      taskDescription: 'Test task',
      taskPrompt: 'Test prompt',
      status: 'running',
      toolCalls: [],
    };

    // Should not throw
    expect(() => handler('task-call-id', taskDisplay)).not.toThrow();
  });
});

describe('functionResponsePartsToString', () => {
  it('should extract output from functionResponse parts', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          response: {
            output: 'function output',
          },
        },
      },
    ];
    expect(functionResponsePartsToString(parts)).toBe('function output');
  });

  it('should handle multiple functionResponse parts', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          response: {
            output: 'output1',
          },
        },
      },
      {
        functionResponse: {
          response: {
            output: 'output2',
          },
        },
      },
    ];
    expect(functionResponsePartsToString(parts)).toBe('output1output2');
  });

  it('should return empty string for missing output', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          response: {},
        },
      },
    ];
    expect(functionResponsePartsToString(parts)).toBe('');
  });

  it('should JSON.stringify non-functionResponse parts', () => {
    const parts: Part[] = [
      { text: 'text part' },
      {
        functionResponse: {
          response: {
            output: 'function output',
          },
        },
      },
    ];
    const result = functionResponsePartsToString(parts);
    expect(result).toContain('function output');
    expect(result).toContain('text part');
  });

  it('should handle empty array', () => {
    expect(functionResponsePartsToString([])).toBe('');
  });

  it('should handle functionResponse with null response', () => {
    const parts: Part[] = [
      {
        functionResponse: {
          response: null as unknown as Record<string, unknown>,
        },
      },
    ];
    expect(functionResponsePartsToString(parts)).toBe('');
  });
});

describe('toolResultContent', () => {
  it('should return resultDisplay string when available', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: 'Result content',
      responseParts: [],
      error: undefined,
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBe('Result content');
  });

  it('should return undefined for empty resultDisplay string', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: '   ',
      responseParts: [],
      error: undefined,
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBeUndefined();
  });

  it('should use functionResponsePartsToString for responseParts', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: undefined,
      responseParts: [
        {
          functionResponse: {
            response: {
              output: 'function output',
            },
          },
        },
      ],
      error: undefined,
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBe('function output');
  });

  it('should return error message when error is present', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: undefined,
      responseParts: [],
      error: new Error('Test error message'),
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBe('Test error message');
  });

  it('should prefer resultDisplay over responseParts', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: 'Direct result',
      responseParts: [
        {
          functionResponse: {
            response: {
              output: 'function output',
            },
          },
        },
      ],
      error: undefined,
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBe('Direct result');
  });

  it('should prefer responseParts over error', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: undefined,
      error: new Error('Error message'),
      responseParts: [
        {
          functionResponse: {
            response: {
              output: 'function output',
            },
          },
        },
      ],
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBe('function output');
  });

  it('should return undefined when no content is available', () => {
    const response: ToolCallResponseInfo = {
      callId: 'test-call',
      resultDisplay: undefined,
      responseParts: [],
      error: undefined,
      errorType: undefined,
    };
    expect(toolResultContent(response)).toBeUndefined();
  });
});
