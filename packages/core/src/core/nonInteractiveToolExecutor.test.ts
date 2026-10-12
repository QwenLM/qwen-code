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

  it('should execute a tool successfully', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call1',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-1',
    };
    const toolResult: ToolResult = {
      llmContent: 'Tool executed successfully',
      returnDisplay: 'Success!',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue(toolResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(mockToolRegistry.getTool).toHaveBeenCalledWith('testTool');
    expect(executeFn).toHaveBeenCalledWith(request.args);
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
    const directRequest: ToolCallRequestInfo = {
      callId: 'direct-call',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-direct',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue({
      llmContent: 'record later',
      returnDisplay: 'record later',
    } satisfies ToolResult);

    const directResponse = await executeToolCall(
      mockConfig,
      directRequest,
      abortController.signal,
    );

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
    const request: ToolCallRequestInfo = {
      callId: 'runtime-call',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'runtime-prompt',
    };
    const runtimeView = {
      contentGenerator: {},
      contentGeneratorConfig: {
        model: 'vision-agent',
        authType: 'openai',
      },
    } as unknown as RuntimeContentGeneratorView;
    let observedRuntime: RuntimeContentGeneratorView | undefined;
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockImplementation(() => {
      observedRuntime = getRuntimeContentGenerator();
      return Promise.resolve({
        llmContent: 'done',
        returnDisplay: 'done',
      });
    });

    await executeToolCall(mockConfig, request, abortController.signal, {
      runtimeView,
    });

    expect(observedRuntime).toBe(runtimeView);
  });

  it('should return an error if tool is not found', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call2',
      name: 'nonexistentTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-2',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(undefined);
    vi.mocked(mockToolRegistry.getAllToolNames).mockReturnValue([
      'testTool',
      'anotherTool',
    ]);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    const expectedErrorMessage =
      'Tool "nonexistentTool" not found in registry. Tools must use the exact names that are registered. Did you mean one of: "testTool", "anotherTool"?';
    expect(response).toStrictEqual({
      callId: 'call2',
      error: new Error(expectedErrorMessage),
      errorType: ToolErrorType.TOOL_NOT_REGISTERED,
      executionStatus: 'not_started',
      resultDisplay: expectedErrorMessage,
      contentLength: expectedErrorMessage.length,
      responseParts: [
        {
          functionResponse: {
            name: 'nonexistentTool',
            id: 'call2',
            response: {
              error: expectedErrorMessage,
            },
          },
        },
      ],
    });
  });

  it('should return an error if tool validation fails', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call3',
      name: 'testTool',
      args: { param1: 'invalid' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-3',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    vi.spyOn(mockTool, 'build').mockImplementation(() => {
      throw new Error('Invalid parameters');
    });

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );
    expect(response).toStrictEqual({
      callId: 'call3',
      error: new Error('Invalid parameters'),
      errorType: ToolErrorType.INVALID_TOOL_PARAMS,
      executionStatus: 'not_started',
      responseParts: [
        {
          functionResponse: {
            id: 'call3',
            name: 'testTool',
            response: {
              error: 'Invalid parameters',
            },
          },
        },
      ],
      resultDisplay: 'Invalid parameters',
      contentLength: 'Invalid parameters'.length,
    });
  });

  it('should return an error if tool execution fails', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call4',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-4',
    };
    const executionErrorResult: ToolResult = {
      llmContent: 'Error: Execution failed',
      returnDisplay: 'Execution failed',
      error: {
        message: 'Execution failed',
        type: ToolErrorType.EXECUTION_FAILED,
      },
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue(executionErrorResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );
    expect(response).toStrictEqual({
      callId: 'call4',
      error: new Error('Execution failed'),
      errorType: ToolErrorType.EXECUTION_FAILED,
      executionStatus: 'error',
      responseParts: [
        {
          functionResponse: {
            id: 'call4',
            name: 'testTool',
            response: {
              error: 'Execution failed',
            },
          },
        },
      ],
      resultDisplay: 'Execution failed',
      contentLength: 'Execution failed'.length,
    });
  });

  it('should return an unhandled exception error if execution throws', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call5',
      name: 'testTool',
      args: { param1: 'value1' },
      isClientInitiated: false,
      prompt_id: 'prompt-id-5',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockRejectedValue(new Error('Something went very wrong'));

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(response).toStrictEqual({
      callId: 'call5',
      error: new Error('Something went very wrong'),
      errorType: ToolErrorType.UNHANDLED_EXCEPTION,
      executionStatus: 'error',
      resultDisplay: 'Something went very wrong',
      contentLength: 'Something went very wrong'.length,
      responseParts: [
        {
          functionResponse: {
            name: 'testTool',
            id: 'call5',
            response: { error: 'Something went very wrong' },
          },
        },
      ],
    });
  });

  it('should correctly format llmContent with inlineData', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call6',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-6',
    };
    const imageDataPart: Part = {
      inlineData: { mimeType: 'image/png', data: 'base64data' },
    };
    const toolResult: ToolResult = {
      llmContent: [imageDataPart],
      returnDisplay: 'Image processed',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue(toolResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

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
    const request: ToolCallRequestInfo = {
      callId: 'call7',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-7',
    };
    const toolResult: ToolResult = {
      llmContent: 'This is a test string.',
      returnDisplay: 'String returned',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue(toolResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(response.contentLength).toBe(
      typeof toolResult.llmContent === 'string'
        ? toolResult.llmContent.length
        : undefined,
    );
  });

  it('should have undefined contentLength for array llmContent with no string parts', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'call8',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-id-8',
    };
    const toolResult: ToolResult = {
      llmContent: [{ inlineData: { mimeType: 'image/png', data: 'fakedata' } }],
      returnDisplay: 'Image data returned',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue(toolResult);

    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
    );

    expect(response.contentLength).toBeUndefined();
  });

  it('revalidates rewritten Mod arguments and reports the actual request once', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'mod',
      name: 'testTool',
      args: { param1: 'original' },
      isClientInitiated: false,
      prompt_id: 'prompt',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockImplementation(async (args) => ({
      llmContent: String(args.param1),
      returnDisplay: args.param1,
    }));
    const completed = vi.fn();
    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
      {
        recordToolResult: false,
        onAllToolCallsComplete: completed,
        modToolCall: async (e, next, signal) => {
          const result = await next(
            { ...e, param1: 'rewritten' },
            signal,
            async (_e, verdict) => verdict,
          );
          return { ...result, result: { output: 'wrapped' } };
        },
      },
    );
    expect(executeFn).toHaveBeenCalledWith({ param1: 'rewritten' });
    expect(request.args).toEqual({ param1: 'original' });
    expect(response.responseParts).toEqual([
      {
        functionResponse: {
          id: 'mod',
          name: 'testTool',
          response: { output: 'wrapped' },
        },
      },
    ]);
    expect(response.executionStatus).toBe('success');
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0][0].request.args).toEqual({
      param1: 'rewritten',
    });
    expect(completed.mock.calls[0][0][0].response).toBe(response);
  });

  it('does not execute or forge success after native validation fails', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'mod',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    vi.spyOn(mockTool, 'build').mockImplementation(() => {
      throw new Error('schema rejected');
    });
    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
      {
        modToolCall: async (e, next, signal) => {
          await next(e, signal, async () => ({ decision: 'allow' }));
          return { result: { output: 'forged success' } };
        },
      },
    );
    expect(executeFn).not.toHaveBeenCalled();
    expect(response.executionStatus).toBe('not_started');
    expect(response.error?.message).toBe('schema rejected');
  });

  it('repeats native executions but retains one outer result and actual response metadata', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'mod',
      name: 'testTool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn
      .mockResolvedValueOnce({
        llmContent: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }],
        returnDisplay: 'first image',
      })
      .mockResolvedValueOnce({
        llmContent: [{ inlineData: { mimeType: 'image/png', data: 'def' } }],
        returnDisplay: 'second image',
      });
    const completed = vi.fn();
    const recordToolResult = vi.fn();
    mockConfig.getChatRecordingService = () =>
      ({ recordToolResult }) as unknown as ReturnType<
        Config['getChatRecordingService']
      >;
    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
      {
        onAllToolCallsComplete: completed,
        modToolCall: async (e, next, signal) => {
          const one = await next(e, signal, async (_e, v) => v);
          await next({ ...e, param1: 'second' }, signal, async (_e, v) => v);
          return { ...one, text: 'cannot forge native text', isError: true };
        },
      },
    );
    expect(executeFn).toHaveBeenCalledTimes(2);
    expect(response.error).toBeUndefined();
    expect(response.responseParts[0].functionResponse?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'abc' } },
    ]);
    expect(recordToolResult).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(response.resultDisplay).toBe('first image');
    expect(completed.mock.calls[0][0][0].request.args).toEqual({
      param1: 'second',
    });
  });

  it.each([
    ['validation', false],
    ['validation', true],
    ['permission', false],
    ['permission', true],
    ['execution', false],
    ['execution', true],
  ] as const)(
    'retains later execution facts when returning an earlier %s failure (rewritten: %s)',
    async (failure, rewritten) => {
      const request: ToolCallRequestInfo = {
        callId: 'mod',
        name: 'testTool',
        args: { param1: 'original' },
        isClientInitiated: false,
        prompt_id: 'prompt',
      };
      mockTool = new MockTool({
        name: 'testTool',
        params: {
          type: 'object',
          properties: { param1: { type: 'string' } },
          required: ['param1'],
        },
        execute: executeFn,
      });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
      executeFn.mockResolvedValue({
        llmContent: 'executed',
        returnDisplay: 'executed',
      });
      if (failure === 'execution')
        executeFn.mockRejectedValueOnce(new Error('first attempt failed'));
      const completed = vi.fn();
      const recordToolResult = vi.fn();
      mockConfig.getChatRecordingService = () =>
        ({ recordToolResult }) as unknown as ReturnType<
          Config['getChatRecordingService']
        >;
      const response = await executeToolCall(
        mockConfig,
        request,
        abortController.signal,
        {
          onAllToolCallsComplete: completed,
          modToolCall: async (e, next, signal) => {
            const { param1: _param1, ...invalid } = e;
            const first = await next(
              failure === 'validation' ? invalid : e,
              signal,
              async (_e, verdict) =>
                failure === 'permission' ? { decision: 'deny' } : verdict,
            );
            expect(first).toMatchObject({ isError: true });
            await next(
              { ...e, param1: 'executed' },
              signal,
              async (_e, v) => v,
            );
            return rewritten
              ? { ...first, result: { output: 'rewritten first result' } }
              : first;
          },
        },
      );

      expect(executeFn).toHaveBeenCalledTimes(failure === 'execution' ? 2 : 1);
      expect(executeFn).toHaveBeenLastCalledWith({ param1: 'executed' });
      expect(response.error).toBeDefined();
      expect(response.responseParts[0].functionResponse?.response).toEqual(
        rewritten
          ? { output: 'rewritten first result' }
          : { error: expect.any(String) },
      );
      expect(response.executionStatus).toBe('success');
      expect(completed).toHaveBeenCalledTimes(1);
      expect(completed.mock.calls[0][0][0]).toMatchObject({
        status: 'success',
        request: { ...request, args: { param1: 'executed' } },
        response,
      });
      expect(recordToolResult).toHaveBeenCalledTimes(1);
      expect(recordToolResult).toHaveBeenCalledWith(
        response.responseParts,
        expect.objectContaining({
          executionStatus: 'success',
          status: 'success',
        }),
      );
    },
  );

  it('restores reserved argument collisions and ignores forged result identity fields', async () => {
    const request: ToolCallRequestInfo = {
      callId: 'mod',
      name: 'testTool',
      args: {
        tool: 'inner-tool',
        tool_use_id: 'inner-id',
        consent: 'inner-consent',
      },
      isClientInitiated: false,
      prompt_id: 'prompt',
    };
    vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
    executeFn.mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' });
    const response = await executeToolCall(
      mockConfig,
      request,
      abortController.signal,
      {
        modToolCall: async (e, next, signal) => {
          expect(e.tool).toBe('testTool');
          expect(e['$shadowed']).toEqual(request.args);
          await next(e, signal, async (_e, v) => v);
          return {
            result: {
              functionResponse: { id: 'forged' },
              executionStatus: 'forged',
            },
            ref: 900,
            isReadOnly: true,
          };
        },
      },
    );
    expect(executeFn).toHaveBeenCalledWith(request.args);
    expect(response.callId).toBe('mod');
    expect(response.responseParts[0].functionResponse?.id).toBe('mod');
    expect(response.executionStatus).toBe('success');
  });

  it.each([false, true])(
    'describes whether a Mod denial happened after execution (%s)',
    async (execute) => {
      const request: ToolCallRequestInfo = {
        callId: 'mod',
        name: 'testTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt',
      };
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);
      executeFn.mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' });
      const response = await executeToolCall(
        mockConfig,
        request,
        abortController.signal,
        {
          modToolCall: async (e, next, signal) => {
            if (execute) await next(e, signal, async (_e, v) => v);
            return { deny: '' };
          },
        },
      );
      expect(executeFn).toHaveBeenCalledTimes(execute ? 1 : 0);
      expect(response.executionStatus).toBe(
        execute ? 'success' : 'not_started',
      );
      expect(response.error?.message).toMatch(
        execute ? /tool ran/ : /denied by Mod/,
      );
    },
  );
});
