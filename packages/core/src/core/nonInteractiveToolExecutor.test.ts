/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { executeToolCall } from './nonInteractiveToolExecutor.js';
import type {
  ToolRegistry,
  ToolCallRequestInfo,
  ToolResult,
  Config,
  RuntimeContentGeneratorView,
} from '../index.js';
import {
  DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
  DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
  ToolErrorType,
  ApprovalMode,
  getRuntimeContentGenerator,
} from '../index.js';
import type { Part } from '@google/genai';
import { MockTool } from '../test-utils/mock-tool.js';
import { fnResponse } from '../test-utils/model-fixtures.js';

describe('executeToolCall', () => {
  let mockToolRegistry: ToolRegistry;
  let mockTool: MockTool;
  let executeFn: Mock;
  let abortController: AbortController;
  let mockConfig: Config;

  beforeEach(() => {
    executeFn = vi.fn();
    mockTool = new MockTool({ name: 'testTool', execute: executeFn });

    mockToolRegistry = {
      getTool: vi.fn(),
      ensureTool: vi.fn(async (name: string) => mockToolRegistry.getTool(name)),
      getAllToolNames: vi.fn(),
    } as unknown as ToolRegistry;

    mockConfig = {
      getToolRegistry: () => mockToolRegistry,
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getAllowedTools: () => [],
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getContentGeneratorConfig: () => ({
        model: 'test-model',
        authType: 'gemini',
      }),
      getShellExecutionConfig: () => ({
        terminalWidth: 90,
        terminalHeight: 30,
      }),
      storage: {
        getProjectTempDir: () => '/tmp',
      },
      getTruncateToolOutputThreshold: () =>
        DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD,
      getTruncateToolOutputLines: () => DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES,
      getUseModelRouter: () => false,
      getLlmClient: () => null, // No client needed for these tests
      getChatRecordingService: () => undefined,
      getMessageBus: vi.fn().mockReturnValue(undefined),
      getDisableAllHooks: vi.fn().mockReturnValue(true),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDebugLogger: vi.fn().mockReturnValue({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
      isInteractive: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    abortController = new AbortController();
  });

  const request = (
    callId: string,
    prompt_id: string,
    args: Record<string, unknown> = {},
    name = 'testTool',
  ): ToolCallRequestInfo => ({
    callId,
    name,
    args,
    isClientInitiated: false,
    prompt_id,
  });

  /** Registers the mock tool, optionally resolves `execute` with `result`,
   * and runs the call. */
  const run = (
    call: ToolCallRequestInfo,
    result?: ToolResult,
    options?: Parameters<typeof executeToolCall>[3],
  ) => {
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    if (result) executeFn.mockResolvedValue(result);
    return executeToolCall(mockConfig, call, abortController.signal, options);
  };

  /** The full response of a call that failed with `message`. */
  const errorResponse = (
    call: ToolCallRequestInfo,
    message: string,
    errorType: ToolErrorType,
    executionStatus: 'not_started' | 'error',
  ) => ({
    callId: call.callId,
    error: new Error(message),
    errorType,
    executionStatus,
    resultDisplay: message,
    contentLength: message.length,
    responseParts: [fnResponse(call.name, { error: message }, call.callId)],
  });

  it('should execute a tool successfully', async () => {
    const call = request('call1', 'prompt-id-1', { param1: 'value1' });
    const toolResult: ToolResult = {
      llmContent: 'Tool executed successfully',
      returnDisplay: 'Success!',
    };

    const response = await run(call, toolResult);

    expect(mockToolRegistry.getTool).toHaveBeenCalledWith('testTool');
    expect(executeFn).toHaveBeenCalledWith(call.args);
    expect(response).toStrictEqual({
      callId: 'call1',
      error: undefined,
      errorType: undefined,
      executionStatus: 'success',
      resultDisplay: 'Success!',
      contentLength:
        typeof toolResult.llmContent === 'string'
          ? toolResult.llmContent.length
          : undefined,
      responseParts: [
        {
          functionResponse: {
            name: 'testTool',
            id: 'call1',
            response: { output: 'Tool executed successfully' },
          },
        },
      ],
    });
  });

  it('records direct calls by default and can defer to an outer boundary', async () => {
    const recordToolResult = vi.fn();
    mockConfig.getChatRecordingService = () =>
      ({
        recordToolResult,
        recordUiTelemetryEvent: vi.fn(),
      }) as unknown as ReturnType<Config['getChatRecordingService']>;
    const directRequest = request('direct-call', 'prompt-direct', {
      param1: 'value1',
    });

    const directResponse = await run(directRequest, {
      llmContent: 'record later',
      returnDisplay: 'record later',
    });

    expect(recordToolResult).toHaveBeenCalledWith(
      directResponse.responseParts,
      expect.objectContaining({ callId: directRequest.callId }),
    );
    recordToolResult.mockClear();
    const deferredRequest = { ...directRequest, callId: 'deferred-call' };
    await expect(
      executeToolCall(mockConfig, deferredRequest, abortController.signal, {
        recordToolResult: false,
      }),
    ).resolves.toEqual(
      expect.objectContaining({ callId: deferredRequest.callId }),
    );
    expect(recordToolResult).not.toHaveBeenCalled();
  });

  it('runs the tool with the requested runtime content generator', async () => {
    const runtimeView = {
      contentGenerator: {},
      contentGeneratorConfig: {
        model: 'vision-agent',
        authType: 'openai',
      },
    } as unknown as RuntimeContentGeneratorView;
    let observedRuntime: RuntimeContentGeneratorView | undefined;
    executeFn.mockImplementation(() => {
      observedRuntime = getRuntimeContentGenerator();
      return Promise.resolve({
        llmContent: 'done',
        returnDisplay: 'done',
      });
    });

    await run(request('runtime-call', 'runtime-prompt'), undefined, {
      runtimeView,
    });

    expect(observedRuntime).toBe(runtimeView);
  });

  it('should return an error if tool is not found', async () => {
    const call = request('call2', 'prompt-id-2', {}, 'nonexistentTool');
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(undefined);
    vi.mocked(mockToolRegistry.getAllToolNames).mockReturnValue([
      'testTool',
      'anotherTool',
    ]);

    const response = await executeToolCall(
      mockConfig,
      call,
      abortController.signal,
    );

    expect(response).toStrictEqual(
      errorResponse(
        call,
        'Tool "nonexistentTool" not found in registry. Tools must use the exact names that are registered. Did you mean one of: "testTool", "anotherTool"?',
        ToolErrorType.TOOL_NOT_REGISTERED,
        'not_started',
      ),
    );
  });

  it('should return an error if tool validation fails', async () => {
    const call = request('call3', 'prompt-id-3', { param1: 'invalid' });
    vi.spyOn(mockTool, 'build').mockImplementation(() => {
      throw new Error('Invalid parameters');
    });

    expect(await run(call)).toStrictEqual(
      errorResponse(
        call,
        'Invalid parameters',
        ToolErrorType.INVALID_TOOL_PARAMS,
        'not_started',
      ),
    );
  });

  it('should return an error if tool execution fails', async () => {
    const call = request('call4', 'prompt-id-4', { param1: 'value1' });
    const response = await run(call, {
      llmContent: 'Error: Execution failed',
      returnDisplay: 'Execution failed',
      error: {
        message: 'Execution failed',
        type: ToolErrorType.EXECUTION_FAILED,
      },
    });

    expect(response).toStrictEqual(
      errorResponse(
        call,
        'Execution failed',
        ToolErrorType.EXECUTION_FAILED,
        'error',
      ),
    );
  });

  it('should return an unhandled exception error if execution throws', async () => {
    const call = request('call5', 'prompt-id-5', { param1: 'value1' });
    executeFn.mockRejectedValue(new Error('Something went very wrong'));

    expect(await run(call)).toStrictEqual(
      errorResponse(
        call,
        'Something went very wrong',
        ToolErrorType.UNHANDLED_EXCEPTION,
        'error',
      ),
    );
  });

  it('should correctly format llmContent with inlineData', async () => {
    const imageDataPart: Part = {
      inlineData: { mimeType: 'image/png', data: 'base64data' },
    };
    const response = await run(request('call6', 'prompt-id-6'), {
      llmContent: [imageDataPart],
      returnDisplay: 'Image processed',
    });

    expect(response).toStrictEqual({
      callId: 'call6',
      error: undefined,
      errorType: undefined,
      executionStatus: 'success',
      resultDisplay: 'Image processed',
      contentLength: undefined,
      responseParts: [
        {
          functionResponse: {
            name: 'testTool',
            id: 'call6',
            response: {
              output: '',
            },
            parts: [
              { inlineData: { mimeType: 'image/png', data: 'base64data' } },
            ],
          },
        },
      ],
    });
  });

  it('should calculate contentLength for a string llmContent', async () => {
    const toolResult: ToolResult = {
      llmContent: 'This is a test string.',
      returnDisplay: 'String returned',
    };
    const response = await run(request('call7', 'prompt-id-7'), toolResult);

    expect(response.contentLength).toBe(
      typeof toolResult.llmContent === 'string'
        ? toolResult.llmContent.length
        : undefined,
    );
  });

  it('should have undefined contentLength for array llmContent with no string parts', async () => {
    const response = await run(request('call8', 'prompt-id-8'), {
      llmContent: [{ inlineData: { mimeType: 'image/png', data: 'fakedata' } }],
      returnDisplay: 'Image data returned',
    });

    expect(response.contentLength).toBeUndefined();
  });
});
