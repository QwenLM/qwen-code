/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type ToolRegistry,
  type ToolCallRequestInfo,
  executeToolCall,
  ToolErrorType,
  ToolConfirmationOutcome,
  shutdownTelemetry,
  GeminiEventType,
  type ServerGeminiStreamEvent,
  convertToFunctionResponse,
} from '@qwen-code/qwen-code-core';
import { type Part } from '@google/genai';
import { runNonInteractive } from './nonInteractiveCli.js';
import { vi } from 'vitest';
import type { StreamJsonUserEnvelope } from './streamJson/types.js';
import type { StreamJsonWriter } from './streamJson/writer.js';
import type { StreamJsonController } from './streamJson/controller.js';

type AwaitingApprovalToolCall = {
  status: 'awaiting_approval';
  request: ToolCallRequestInfo;
  confirmationDetails: {
    onConfirm: (
      outcome: ToolConfirmationOutcome,
      payload?: unknown,
    ) => Promise<void>;
  };
};

// Mock core modules
vi.mock('./ui/hooks/atCommandProcessor.js');
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...original,
    executeToolCall: vi.fn(),
    shutdownTelemetry: vi.fn(),
    isTelemetrySdkInitialized: vi.fn().mockReturnValue(true),
    convertToFunctionResponse: vi
      .fn()
      .mockImplementation(
        (_toolName: string, callId: string, content: unknown) => [
          { text: `converted-${callId}-${JSON.stringify(content)}` },
        ],
      ),
  };
});

describe('runNonInteractive', () => {
  let mockConfig: Config;
  let mockToolRegistry: ToolRegistry;
  let mockCoreExecuteToolCall: vi.Mock;
  let mockShutdownTelemetry: vi.Mock;
  let consoleErrorSpy: vi.SpyInstance;
  let processStdoutSpy: vi.SpyInstance;
  let mockGeminiClient: {
    sendMessageStream: vi.Mock;
    getChat: vi.Mock;
  };
  let mockGetDebugResponses: vi.Mock;

  beforeEach(async () => {
    mockCoreExecuteToolCall = vi.mocked(executeToolCall);
    mockShutdownTelemetry = vi.mocked(shutdownTelemetry);
    vi.mocked(convertToFunctionResponse).mockClear();
    vi.mocked(convertToFunctionResponse).mockImplementation(
      (_toolName: string, callId: string, content: unknown) => [
        { text: `converted-${callId}-${JSON.stringify(content)}` },
      ],
    );

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processStdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    mockToolRegistry = {
      getTool: vi.fn(),
      getFunctionDeclarations: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    mockGetDebugResponses = vi.fn(() => []);

    mockGeminiClient = {
      sendMessageStream: vi.fn(),
      getChat: vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
      })),
    };

    let currentModel = 'test-model';

    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getMaxSessionTurns: vi.fn().mockReturnValue(10),
      getIdeMode: vi.fn().mockReturnValue(false),
      getFullContext: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getDebugMode: vi.fn().mockReturnValue(false),
      getOutputFormat: vi.fn().mockReturnValue('text'),
      getIncludePartialMessages: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('session-id'),
      getModel: vi.fn(() => currentModel),
      setModel: vi.fn(async (model: string) => {
        currentModel = model;
      }),
    } as unknown as Config;

    const { handleAtCommand } = await import(
      './ui/hooks/atCommandProcessor.js'
    );
    vi.mocked(handleAtCommand).mockImplementation(async ({ query }) => ({
      processedQuery: [{ text: query }],
      shouldProceed: true,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function* createStreamFromEvents(
    events: ServerGeminiStreamEvent[],
  ): AsyncGenerator<ServerGeminiStreamEvent> {
    for (const event of events) {
      yield event;
    }
  }

  it('should process input and write text output', async () => {
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello' },
      { type: GeminiEventType.Content, value: ' World' },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(mockConfig, 'Test input', 'prompt-id-1');

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Test input' }],
      expect.any(AbortSignal),
      'prompt-id-1',
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Hello');
    expect(processStdoutSpy).toHaveBeenCalledWith(' World');
    expect(processStdoutSpy).toHaveBeenCalledWith('\n');
    expect(mockShutdownTelemetry).toHaveBeenCalled();
  });

  it('should handle a single tool call and respond', async () => {
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-2',
      },
    };
    const toolResponse: Part[] = [{ text: 'Tool response' }];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    const firstCallEvents: ServerGeminiStreamEvent[] = [toolCallEvent];
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Final answer' },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(mockConfig, 'Use a tool', 'prompt-id-2');

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: 'testTool' }),
      expect.any(AbortSignal),
      undefined,
    );
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [{ text: 'Tool response' }],
      expect.any(AbortSignal),
      'prompt-id-2',
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer');
    expect(processStdoutSpy).toHaveBeenCalledWith('\n');
  });

  it('should emit stream-json envelopes when output format is stream-json', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello JSON' },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(mockConfig, 'Stream mode input', 'prompt-id-json');

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    expect(envelopes.at(0)?.type).toBe('user');
    expect(envelopes.at(1)?.type).toBe('assistant');
    expect(envelopes.at(1)?.message?.content?.[0]?.text).toBe('Hello JSON');
    expect(envelopes.at(-1)?.type).toBe('result');
  });

  it('should emit stream events when include-partial-messages is enabled', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as vi.Mock).mockReturnValue(true);
    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Thought,
        value: { subject: 'Plan', description: 'Assess repo' },
      },
      { type: GeminiEventType.Content, value: 'A' },
      { type: GeminiEventType.Content, value: 'B' },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(mockConfig, 'Partial stream', 'prompt-id-partial');

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const streamEvents = envelopes.filter(
      (envelope) => envelope.type === 'stream_event',
    );

    expect(streamEvents.length).toBeGreaterThan(0);
    expect(
      streamEvents.some(
        (event) =>
          event.event?.type === 'content_block_delta' &&
          event.event?.delta?.type === 'thinking_delta',
      ),
    ).toBe(true);
    expect(
      streamEvents.some(
        (event) =>
          event.event?.type === 'content_block_delta' &&
          event.event?.delta?.type === 'text_delta',
      ),
    ).toBe(true);
    expect(envelopes.at(-1)?.type).toBe('result');
  });

  it('should emit tool result envelopes in stream-json mode', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as vi.Mock).mockReturnValue(true);
    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { value: 1 },
        isClientInitiated: false,
        prompt_id: 'prompt-id-stream-tool',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'Tool output' }],
      resultDisplay: 'Tool output',
    });

    const firstEvents: ServerGeminiStreamEvent[] = [toolCallEvent];
    const secondEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Done' },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondEvents));

    await runNonInteractive(
      mockConfig,
      'Tool invocation',
      'prompt-id-stream-tool',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const streamEvents = envelopes.filter(
      (env) => env.type === 'stream_event',
    );
    expect(
      streamEvents.some(
        (event) =>
          event.event?.type === 'content_block_delta' &&
          event.event?.delta?.type === 'input_json_delta',
      ),
    ).toBe(true);

    const userEnvelopes = envelopes.filter((env) => env.type === 'user');
    expect(
      userEnvelopes.some(
        (env) =>
          env.parent_tool_use_id === 'tool-1' &&
          env.message?.content?.[0]?.type === 'tool_result',
      ),
    ).toBe(true);
    expect(envelopes.at(-2)?.type).toBe('assistant');
    expect(envelopes.at(-2)?.message?.content?.[0]?.text).toBe('Done');
    expect(envelopes.at(-1)?.type).toBe('result');
  });

  it('honours updated tool input and emits approval system message', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    mockCoreExecuteToolCall.mockImplementation(
      async (_config, requestInfo, _signal, options) => {
        options?.onToolCallsUpdate?.([
          {
            status: 'awaiting_approval',
            request: requestInfo,
            confirmationDetails: {
              onConfirm,
            },
          } as unknown as AwaitingApprovalToolCall,
        ]);
        return { responseParts: [] };
      },
    );

    const sendControlRequest = vi.fn().mockResolvedValue({
      success: true,
      response: {
        behavior: 'allow',
        updatedInput: { arg1: 'updated' },
        message: 'Approved by host',
      },
    });

    const interruptActiveRun = vi.fn();
    const systemMessages: Array<{ subtype: string; data?: unknown }> = [];
    const streamJsonWriter = {
      emitSystemMessage: vi
        .fn<(subtype: string, data?: unknown) => void>()
        .mockImplementation((subtype, data) => {
          systemMessages.push({ subtype, data });
        }),
      emitResult: vi.fn(),
      writeEnvelope: vi.fn(),
      emitUserMessageFromParts: vi.fn(),
      emitToolResult: vi.fn(),
      createAssistantBuilder: vi.fn(() => ({
        appendText: vi.fn(),
        appendThinking: vi.fn(),
        appendToolUse: vi.fn(),
        finalize: vi.fn(() => ({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        })),
      })),
    } as unknown as StreamJsonWriter;

    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'call-1',
        name: 'testTool',
        args: { arg1: 'original' },
        isClientInitiated: false,
        prompt_id: 'prompt-can_use',
      },
    };

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([toolCallEvent]),
    );

    await runNonInteractive(mockConfig, 'Use tool', 'prompt-can_use', {
      streamJson: {
        writer: streamJsonWriter,
        controller: {
          sendControlRequest,
          interruptActiveRun,
        } as unknown as StreamJsonController,
      },
    });

    expect(sendControlRequest).toHaveBeenCalledWith(
      'can_use_tool',
      expect.objectContaining({ tool_name: 'testTool' }),
      expect.any(Object),
    );
    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(
      mockCoreExecuteToolCall.mock.calls[0]?.[1]?.args,
    ).toEqual({ arg1: 'updated' });
    expect(
      systemMessages.some(
        (entry) =>
          entry.subtype === 'tool_permission' &&
          (entry.data as { message?: string })?.['message'] ===
            'Approved by host',
      ),
    ).toBe(true);
    expect(interruptActiveRun).not.toHaveBeenCalled();
  });

  it('cancels tool execution when control response denies permission', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    const onConfirm = vi.fn().mockResolvedValue(undefined);

    mockCoreExecuteToolCall.mockImplementation(
      async (_config, requestInfo, _signal, options) => {
        options?.onToolCallsUpdate?.([
          {
            status: 'awaiting_approval',
            request: requestInfo,
            confirmationDetails: {
              onConfirm,
            },
          } as unknown as AwaitingApprovalToolCall,
        ]);
        return { responseParts: [] };
      },
    );

    const sendControlRequest = vi.fn().mockResolvedValue({
      success: false,
      error: 'Denied by host',
    });

    const streamJsonWriter = {
      emitSystemMessage: vi.fn(),
      emitResult: vi.fn(),
      writeEnvelope: vi.fn(),
      emitUserMessageFromParts: vi.fn(),
      emitToolResult: vi.fn(),
      createAssistantBuilder: vi.fn(() => ({
        appendText: vi.fn(),
        appendThinking: vi.fn(),
        appendToolUse: vi.fn(),
        finalize: vi.fn(() => ({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        })),
      })),
    } as unknown as StreamJsonWriter;

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: 'call-2',
            name: 'testTool',
            args: {},
            isClientInitiated: false,
            prompt_id: 'prompt-deny',
          },
        },
      ]),
    );

    await runNonInteractive(mockConfig, 'Use tool', 'prompt-deny', {
      streamJson: {
        writer: streamJsonWriter,
        controller: {
          sendControlRequest,
          interruptActiveRun: vi.fn(),
        } as unknown as StreamJsonController,
      },
    });

    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.Cancel,
    );
    expect(streamJsonWriter.emitSystemMessage).toHaveBeenCalledWith(
      'tool_permission',
      expect.objectContaining({ behavior: 'error' }),
    );
  });

  it('invokes hook callbacks during tool execution and can suppress output', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'tool-result' }],
    });

    const sendControlRequest = vi
      .fn()
      .mockImplementation((subtype: string, payload: Record<string, unknown>) => {
        if (subtype === 'hook_callback' && payload['callback_id'] === 'pre') {
          return Promise.resolve({
            success: true,
            response: { decision: 'continue' },
          });
        }
        if (subtype === 'hook_callback' && payload['callback_id'] === 'post') {
          return Promise.resolve({
            success: true,
            response: {
              suppressOutput: true,
              systemMessage: 'suppressed by hook',
            },
          });
        }
        return Promise.resolve({ success: true, response: { behavior: 'allow' } });
      });

    const interruptActiveRun = vi.fn();
    const streamJsonWriter = {
      emitSystemMessage: vi.fn(),
      emitResult: vi.fn(),
      writeEnvelope: vi.fn(),
      emitUserMessageFromParts: vi.fn(),
      createAssistantBuilder: vi.fn(() => ({
        appendText: vi.fn(),
        appendThinking: vi.fn(),
        appendToolUse: vi.fn(),
        finalize: vi.fn(() => ({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        })),
      })),
      emitToolResult: vi.fn(),
    } as unknown as StreamJsonWriter;

    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'hook-call-1',
        name: 'hookTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-hook',
      },
    };

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'final answer' },
        ]),
      );

    const controlContext = {
      hookCallbacks: new Map([
        ['pre', { event: 'pre_tool' }],
        ['post', { event: 'post_tool' }],
      ]),
      registeredHookEvents: new Set(['pre_tool', 'post_tool']),
      mcpClients: new Map(),
    };

    await runNonInteractive(mockConfig, 'Use hook tool', 'prompt-hook', {
      streamJson: {
        writer: streamJsonWriter,
        controller: {
          sendControlRequest,
          interruptActiveRun,
        } as unknown as StreamJsonController,
        controlContext,
      },
    });

    expect(sendControlRequest).toHaveBeenCalledWith(
      'hook_callback',
      expect.objectContaining({ callback_id: 'pre' }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(sendControlRequest).toHaveBeenCalledWith(
      'hook_callback',
      expect.objectContaining({ callback_id: 'post' }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(streamJsonWriter.emitToolResult).not.toHaveBeenCalled();
    expect(
      streamJsonWriter.emitSystemMessage.mock.calls.some(
        ([subtype, data]) =>
          subtype === 'hook_callback' &&
          (data as { message?: string })?.message === 'suppressed by hook',
      ),
    ).toBe(true);
    expect(interruptActiveRun).not.toHaveBeenCalled();
  });

  it('skips tool execution when hook callback requests cancellation', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    const sendControlRequest = vi
      .fn()
      .mockImplementation((subtype: string, payload: Record<string, unknown>) => {
        if (subtype === 'hook_callback' && payload['callback_id'] === 'pre') {
          return Promise.resolve({
            success: true,
            response: {
              continue: false,
              systemMessage: 'hook denied tool execution',
            },
          });
        }
        if (subtype === 'hook_callback' && payload['callback_id'] === 'post') {
          return Promise.resolve({ success: true, response: {} });
        }
        return Promise.resolve({ success: true, response: { behavior: 'allow' } });
      });

    const streamJsonWriter = {
      emitSystemMessage: vi.fn(),
      emitResult: vi.fn(),
      writeEnvelope: vi.fn(),
      emitUserMessageFromParts: vi.fn(),
      createAssistantBuilder: vi.fn(() => ({
        appendText: vi.fn(),
        appendThinking: vi.fn(),
        appendToolUse: vi.fn(),
        finalize: vi.fn(() => ({
          type: 'assistant',
          message: { role: 'assistant', content: [] },
        })),
      })),
      emitToolResult: vi.fn(),
    } as unknown as StreamJsonWriter;

    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'hook-skip-1',
        name: 'skipTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-skip',
      },
    };

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'final answer' },
        ]),
      );

    const controlContext = {
      hookCallbacks: new Map([
        ['pre', { event: 'pre_tool' }],
        ['post', { event: 'post_tool' }],
      ]),
      registeredHookEvents: new Set(['pre_tool', 'post_tool']),
      mcpClients: new Map(),
    };

    await runNonInteractive(mockConfig, 'Skip via hook', 'prompt-skip', {
      streamJson: {
        writer: streamJsonWriter,
        controller: {
          sendControlRequest,
          interruptActiveRun: vi.fn(),
        } as unknown as StreamJsonController,
        controlContext,
      },
    });

    expect(mockCoreExecuteToolCall).not.toHaveBeenCalled();
    expect(streamJsonWriter.emitToolResult).not.toHaveBeenCalled();
    expect(
      streamJsonWriter.emitSystemMessage.mock.calls.some(
        ([subtype, data]) =>
          subtype === 'hook_callback' &&
          (data as { message?: string })?.message === 'hook denied tool execution',
      ),
    ).toBe(true);
  });

  it('should include usage metadata and api duration in stream-json results', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'All set' },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const usageMetadata = {
      promptTokenCount: 12,
      candidatesTokenCount: 4,
      totalTokenCount: 16,
      cachedContentTokenCount: 2,
    };
    mockGetDebugResponses.mockReturnValue([{ usageMetadata }]);

    const nowSpy = vi.spyOn(Date, 'now');
    let tick = 0;
    nowSpy.mockImplementation(() => {
      tick += 500;
      return tick;
    });

    try {
      await runNonInteractive(mockConfig, 'Usage check', 'prompt-id-usage');
    } finally {
      nowSpy.mockRestore();
    }

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const resultEnvelope = envelopes.at(-1);
    expect(resultEnvelope?.type).toBe('result');
    expect(resultEnvelope?.duration_api_ms).toBeGreaterThan(0);
    expect(resultEnvelope?.usage).toEqual({
      input_tokens: 12,
      output_tokens: 4,
      total_tokens: 16,
      cache_read_input_tokens: 2,
    });
    expect(resultEnvelope?.is_error).toBe(false);
  });

  it('converts structured tool_result envelopes using tool registry mapping', async () => {
    const toolCallRegistry = new Map<string, ToolCallRequestInfo>();
    toolCallRegistry.set('tool-remote', {
      callId: 'tool-remote',
      name: 'remote_tool',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-remote',
    });

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Follow up' },
      ]),
    );

    await runNonInteractive(
      mockConfig,
      '',
      'prompt-remote',
      {
        streamJson: {
          writer: undefined as never,
          controller: undefined as never,
          toolCallRegistry,
        },
        userEnvelope: {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-remote',
                content: 'processed output',
              },
            ],
          },
        } as unknown as StreamJsonUserEnvelope,
      },
    );

    expect(vi.mocked(convertToFunctionResponse)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(convertToFunctionResponse)).toHaveBeenCalledWith(
      'remote_tool',
      'tool-remote',
      'processed output',
    );
    expect(toolCallRegistry.size).toBe(0);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'converted-tool-remote-"processed output"' }],
      expect.any(AbortSignal),
      'prompt-remote',
    );
  });

  it('applies temporary model overrides from stream-json envelope options', async () => {
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Response' },
      ]),
    );

    await runNonInteractive(
      mockConfig,
      'ignored',
      'prompt-temp-model',
      {
        userEnvelope: {
          type: 'user',
          message: { content: 'Hello from envelope' },
          options: { temporary_model: 'temp-model' },
        } as unknown as StreamJsonUserEnvelope,
      },
    );

    expect(mockConfig.setModel).toHaveBeenNthCalledWith(
      1,
      'temp-model',
      expect.objectContaining({ context: 'temporary_model' }),
    );
    expect(mockConfig.setModel).toHaveBeenNthCalledWith(
      2,
      'test-model',
      expect.objectContaining({ context: 'temporary_model_restore' }),
    );
  });

  it('should handle error during tool execution and should send error back to the model', async () => {
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'errorTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-3',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      error: new Error('Execution failed'),
      errorType: ToolErrorType.EXECUTION_FAILED,
      responseParts: [
        {
          functionResponse: {
            name: 'errorTool',
            response: {
              output: 'Error: Execution failed',
            },
          },
        },
      ],
      resultDisplay: 'Execution failed',
    });
    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: 'Sorry, let me try again.',
      },
    ];
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    await runNonInteractive(mockConfig, 'Trigger tool error', 'prompt-id-3');

    expect(mockCoreExecuteToolCall).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error executing tool errorTool: Execution failed',
    );
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [
        {
          functionResponse: {
            name: 'errorTool',
            response: {
              output: 'Error: Execution failed',
            },
          },
        },
      ],
      expect.any(AbortSignal),
      'prompt-id-3',
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Sorry, let me try again.');
  });

  it('should include usage metadata and API duration in stream-json result', async () => {
    (mockConfig.getOutputFormat as vi.Mock).mockReturnValue('stream-json');
    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const nowSpy = vi.spyOn(Date, 'now');
    let current = 0;
    nowSpy.mockImplementation(() => {
      current += 500;
      return current;
    });

    const usageMetadata = {
      promptTokenCount: 11,
      candidatesTokenCount: 5,
      totalTokenCount: 16,
      cachedContentTokenCount: 3,
    };
    mockGetDebugResponses.mockReturnValue([{ usageMetadata }]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'All done' },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(mockConfig, 'usage test', 'prompt-usage');

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const resultEnvelope = envelopes.at(-1);
    expect(resultEnvelope?.type).toBe('result');
    expect(resultEnvelope?.duration_api_ms).toBeGreaterThan(0);
    expect(resultEnvelope?.usage).toEqual({
      input_tokens: 11,
      output_tokens: 5,
      total_tokens: 16,
      cache_read_input_tokens: 3,
    });

    nowSpy.mockRestore();
  });

  it('should exit with error if sendMessageStream throws initially', async () => {
    const apiError = new Error('API connection failed');
    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw apiError;
    });

    await expect(
      runNonInteractive(mockConfig, 'Initial fail', 'prompt-id-4'),
    ).rejects.toThrow(apiError);
  });

  it('should not exit if a tool is not found, and should send error back to model', async () => {
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'nonexistentTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-5',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      error: new Error('Tool "nonexistentTool" not found in registry.'),
      resultDisplay: 'Tool "nonexistentTool" not found in registry.',
    });
    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: "Sorry, I can't find that tool.",
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    await runNonInteractive(
      mockConfig,
      'Trigger tool not found',
      'prompt-id-5',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'Error executing tool nonexistentTool: Tool "nonexistentTool" not found in registry.',
    );
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(processStdoutSpy).toHaveBeenCalledWith(
      "Sorry, I can't find that tool.",
    );
  });

  it('should exit when max session turns are exceeded', async () => {
    vi.mocked(mockConfig.getMaxSessionTurns).mockReturnValue(0);
    await expect(
      runNonInteractive(mockConfig, 'Trigger loop', 'prompt-id-6'),
    ).rejects.toThrow(
      'Reached max session turns for this session. Increase the number of turns by specifying maxSessionTurns in settings.json.',
    );
  });

  it('should preprocess @include commands before sending to the model', async () => {
    // 1. Mock the imported atCommandProcessor
    const { handleAtCommand } = await import(
      './ui/hooks/atCommandProcessor.js'
    );
    const mockHandleAtCommand = vi.mocked(handleAtCommand);

    // 2. Define the raw input and the expected processed output
    const rawInput = 'Summarize @file.txt';
    const processedParts: Part[] = [
      { text: 'Summarize @file.txt' },
      { text: '\n--- Content from referenced files ---\n' },
      { text: 'This is the content of the file.' },
      { text: '\n--- End of content ---' },
    ];

    // 3. Setup the mock to return the processed parts
    mockHandleAtCommand.mockResolvedValue({
      processedQuery: processedParts,
      shouldProceed: true,
    });

    // Mock a simple stream response from the Gemini client
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Summary complete.' },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    // 4. Run the non-interactive mode with the raw input
    await runNonInteractive(mockConfig, rawInput, 'prompt-id-7');

    // 5. Assert that sendMessageStream was called with the PROCESSED parts, not the raw input
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      processedParts,
      expect.any(AbortSignal),
      'prompt-id-7',
    );

    // 6. Assert the final output is correct
    expect(processStdoutSpy).toHaveBeenCalledWith('Summary complete.');
  });
});
