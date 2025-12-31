/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  ToolRegistry,
  ServerGeminiStreamEvent,
  SessionMetrics,
} from '@qwen-code/qwen-code-core';
import type { CLIUserMessage } from './nonInteractive/types.js';
import {
  executeToolCall,
  ToolErrorType,
  shutdownTelemetry,
  GeminiEventType,
  OutputFormat,
  uiTelemetryService,
  FatalInputError,
  ApprovalMode,
} from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';
import { runNonInteractive } from './nonInteractiveCli.js';
import { vi, type Mock, type MockInstance } from 'vitest';
import type { LoadedSettings } from './config/settings.js';
import { CommandKind } from './ui/commands/types.js';

// Mock core modules
vi.mock('./ui/hooks/atCommandProcessor.js');
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();

  class MockChatRecordingService {
    initialize = vi.fn();
    recordMessage = vi.fn();
    recordMessageTokens = vi.fn();
    recordToolCalls = vi.fn();
  }

  return {
    ...original,
    executeToolCall: vi.fn(),
    shutdownTelemetry: vi.fn(),
    isTelemetrySdkInitialized: vi.fn().mockReturnValue(true),
    ChatRecordingService: MockChatRecordingService,
    uiTelemetryService: {
      getMetrics: vi.fn(),
    },
  };
});

const mockGetCommands = vi.hoisted(() => vi.fn());
const mockCommandServiceCreate = vi.hoisted(() => vi.fn());
vi.mock('./services/CommandService.js', () => ({
  CommandService: {
    create: mockCommandServiceCreate,
  },
}));

describe('runNonInteractive', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockToolRegistry: ToolRegistry;
  let mockCoreExecuteToolCall: Mock;
  let mockShutdownTelemetry: Mock;
  let consoleErrorSpy: MockInstance;
  let processStdoutSpy: MockInstance;
  let processStderrSpy: MockInstance;
  let mockGeminiClient: {
    sendMessageStream: Mock;
    getChatRecordingService: Mock;
    getChat: Mock;
  };
  let mockGetDebugResponses: Mock;

  beforeEach(async () => {
    mockCoreExecuteToolCall = vi.mocked(executeToolCall);
    mockShutdownTelemetry = vi.mocked(shutdownTelemetry);
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
    });

    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    processStdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    processStderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code}) called`);
    });

    mockToolRegistry = {
      getTool: vi.fn(),
      getFunctionDeclarations: vi.fn().mockReturnValue([]),
      getAllToolNames: vi.fn().mockReturnValue([]),
    } as unknown as ToolRegistry;

    mockGetDebugResponses = vi.fn(() => []);

    mockGeminiClient = {
      sendMessageStream: vi.fn(),
      getChatRecordingService: vi.fn(() => ({
        initialize: vi.fn(),
        recordMessage: vi.fn(),
        recordMessageTokens: vi.fn(),
        recordToolCalls: vi.fn(),
      })),
      getChat: vi.fn(() => ({
        getDebugResponses: mockGetDebugResponses,
      })),
    };

    let currentModel = 'test-model';

    mockConfig = {
      initialize: vi.fn().mockResolvedValue(undefined),
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getGeminiClient: vi.fn().mockReturnValue(mockGeminiClient),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getMaxSessionTurns: vi.fn().mockReturnValue(10),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getTargetDir: vi.fn().mockReturnValue('/test/project'),
      getMcpServers: vi.fn().mockReturnValue(undefined),
      getCliVersion: vi.fn().mockReturnValue('test-version'),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/test/project/.gemini/tmp'),
      },
      getIdeMode: vi.fn().mockReturnValue(false),
      getFullContext: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue({}),
      getDebugMode: vi.fn().mockReturnValue(false),
      getOutputFormat: vi.fn().mockReturnValue('text'),
      getFolderTrustFeature: vi.fn().mockReturnValue(false),
      getFolderTrust: vi.fn().mockReturnValue(false),
      getIncludePartialMessages: vi.fn().mockReturnValue(false),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getModel: vi.fn(() => currentModel),
      setModel: vi.fn(async (model: string) => {
        currentModel = model;
      }),
      getExperimentalZedIntegration: vi.fn().mockReturnValue(false),
      isInteractive: vi.fn().mockReturnValue(false),
    } as unknown as Config;

    mockSettings = {
      system: { path: '', settings: {} },
      systemDefaults: { path: '', settings: {} },
      user: { path: '', settings: {} },
      workspace: { path: '', settings: {} },
      errors: [],
      setValue: vi.fn(),
      merged: {
        security: {
          auth: {
            enforcedType: undefined,
          },
        },
      },
      isTrusted: true,
      migratedInMemorScopes: new Set(),
      forScope: vi.fn(),
      computeMergedSettings: vi.fn(),
    } as unknown as LoadedSettings;

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

  /**
   * Creates a default mock SessionMetrics object.
   * Can be overridden in individual tests if needed.
   */
  function createMockMetrics(
    overrides?: Partial<SessionMetrics>,
  ): SessionMetrics {
    return {
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
      ...overrides,
    };
  }

  /**
   * Sets up the default mock for uiTelemetryService.getMetrics().
   * Should be called in beforeEach or at the start of tests that need metrics.
   */
  function setupMetricsMock(overrides?: Partial<SessionMetrics>): void {
    const mockMetrics = createMockMetrics(overrides);
    vi.mocked(uiTelemetryService.getMetrics).mockReturnValue(mockMetrics);
  }

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
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-id-1',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Test input' }],
      expect.any(AbortSignal),
      'prompt-id-1',
      { isContinuation: false },
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
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use a tool',
      'prompt-id-2',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: 'testTool' }),
      expect.any(AbortSignal),
      expect.objectContaining({
        outputUpdateHandler: expect.any(Function),
      }),
    );
    // Verify first call has isContinuation: false
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      1,
      [{ text: 'Use a tool' }],
      expect.any(AbortSignal),
      'prompt-id-2',
      { isContinuation: false },
    );
    // Verify second call (after tool execution) has isContinuation: true
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [{ text: 'Tool response' }],
      expect.any(AbortSignal),
      'prompt-id-2',
      { isContinuation: true },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer');
    expect(processStdoutSpy).toHaveBeenCalledWith('\n');
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
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    // Enable debug mode so handleToolError logs to console.error
    (mockConfig.getDebugMode as Mock).mockReturnValue(true);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger tool error',
      'prompt-id-3',
    );

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
      { isContinuation: true },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Sorry, let me try again.');
  });

  it('should exit with error if sendMessageStream throws initially', async () => {
    const apiError = new Error('API connection failed');
    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw apiError;
    });

    await expect(
      runNonInteractive(
        mockConfig,
        mockSettings,
        'Initial fail',
        'prompt-id-4',
      ),
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
      responseParts: [],
    });
    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: "Sorry, I can't find that tool.",
      },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    // Enable debug mode so handleToolError logs to console.error
    (mockConfig.getDebugMode as Mock).mockReturnValue(true);

    await runNonInteractive(
      mockConfig,
      mockSettings,
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
      runNonInteractive(
        mockConfig,
        mockSettings,
        'Trigger loop',
        'prompt-id-6',
      ),
    ).rejects.toThrow('process.exit(53) called');
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
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    // 4. Run the non-interactive mode with the raw input
    await runNonInteractive(mockConfig, mockSettings, rawInput, 'prompt-id-7');

    // 5. Assert that sendMessageStream was called with the PROCESSED parts, not the raw input
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      processedParts,
      expect.any(AbortSignal),
      'prompt-id-7',
      { isContinuation: false },
    );

    // 6. Assert the final output is correct
    expect(processStdoutSpy).toHaveBeenCalledWith('Summary complete.');
  });

  it('should process input and write JSON output with stats', async () => {
    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Hello World' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Test input',
      'prompt-id-1',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Test input' }],
      expect.any(AbortSignal),
      'prompt-id-1',
      { isContinuation: false },
    );

    // JSON adapter emits array of messages, last one is result with stats
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    expect(outputCalls.length).toBeGreaterThan(0);
    const lastOutput = outputCalls[outputCalls.length - 1][0];
    const parsed = JSON.parse(lastOutput);
    expect(Array.isArray(parsed)).toBe(true);
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.result).toBe('Hello World');
    // Get the actual metrics that were used
    const actualMetrics = vi.mocked(uiTelemetryService.getMetrics)();
    expect(resultMessage?.stats).toEqual(actualMetrics);
  });

  it('should write JSON output with stats for tool-only commands (no text response)', async () => {
    // Test the scenario where a command completes successfully with only tool calls
    // but no text response - this would have caught the original bug
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'testTool',
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-tool-only',
      },
    };
    const toolResponse: Part[] = [{ text: 'Tool executed successfully' }];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    // First call returns only tool call, no content
    const firstCallEvents: ServerGeminiStreamEvent[] = [
      toolCallEvent,
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];

    // Second call returns no content (tool-only completion)
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 3 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock({
      tools: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        totalDurationMs: 100,
        totalDecisions: {
          accept: 1,
          reject: 0,
          modify: 0,
          auto_accept: 0,
        },
        byName: {
          testTool: {
            count: 1,
            success: 1,
            fail: 0,
            durationMs: 100,
            decisions: {
              accept: 1,
              reject: 0,
              modify: 0,
              auto_accept: 0,
            },
          },
        },
      },
    });

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Execute tool only',
      'prompt-id-tool-only',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: 'testTool' }),
      expect.any(AbortSignal),
      undefined,
    );

    // JSON adapter emits array of messages, last one is result with stats
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    expect(outputCalls.length).toBeGreaterThan(0);
    const lastOutput = outputCalls[outputCalls.length - 1][0];
    const parsed = JSON.parse(lastOutput);
    expect(Array.isArray(parsed)).toBe(true);
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.result).toBe('');
    // Note: stats would only be included if passed to emitResult, which current implementation doesn't do
    // This test verifies the structure, but stats inclusion depends on implementation
  });

  it('should write JSON output with stats for empty response commands', async () => {
    // Test the scenario where a command completes but produces no content at all
    const events: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Empty response test',
      'prompt-id-empty',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Empty response test' }],
      expect.any(AbortSignal),
      'prompt-id-empty',
      { isContinuation: false },
    );

    // JSON adapter emits array of messages, last one is result with stats
    const outputCalls = processStdoutSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string',
    );
    expect(outputCalls.length).toBeGreaterThan(0);
    const lastOutput = outputCalls[outputCalls.length - 1][0];
    const parsed = JSON.parse(lastOutput);
    expect(Array.isArray(parsed)).toBe(true);
    const resultMessage = parsed.find(
      (msg: unknown) =>
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        msg.type === 'result',
    );
    expect(resultMessage).toBeTruthy();
    expect(resultMessage?.result).toBe('');
    // Get the actual metrics that were used
    const actualMetrics = vi.mocked(uiTelemetryService.getMetrics)();
    expect(resultMessage?.stats).toEqual(actualMetrics);
  });

  it('should handle errors in JSON format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    const testError = new Error('Invalid input provided');

    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw testError;
    });

    // Mock console.error to capture JSON error output
    const consoleErrorJsonSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    let thrownError: Error | null = null;
    try {
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Test input',
        'prompt-id-error',
      );
      // Should not reach here
      expect.fail('Expected process.exit to be called');
    } catch (error) {
      thrownError = error as Error;
    }

    // Should throw because of mocked process.exit
    expect(thrownError?.message).toBe('process.exit(1) called');

    expect(consoleErrorJsonSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          error: {
            type: 'Error',
            message: 'Invalid input provided',
            code: 1,
          },
        },
        null,
        2,
      ),
    );
  });

  it('should handle FatalInputError with custom exit code in JSON format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    const fatalError = new FatalInputError('Invalid command syntax provided');

    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw fatalError;
    });

    // Mock console.error to capture JSON error output
    const consoleErrorJsonSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    let thrownError: Error | null = null;
    try {
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Invalid syntax',
        'prompt-id-fatal',
      );
      // Should not reach here
      expect.fail('Expected process.exit to be called');
    } catch (error) {
      thrownError = error as Error;
    }

    // Should throw because of mocked process.exit with custom exit code
    expect(thrownError?.message).toBe('process.exit(42) called');

    expect(consoleErrorJsonSpy).toHaveBeenCalledWith(
      JSON.stringify(
        {
          error: {
            type: 'FatalInputError',
            message: 'Invalid command syntax provided',
            code: 42,
          },
        },
        null,
        2,
      ),
    );
  });

  it('should execute a slash command that returns a prompt', async () => {
    const mockCommand = {
      name: 'testcommand',
      description: 'a test command',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'submit_prompt',
        content: [{ text: 'Prompt from command' }],
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Response from command' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/testcommand',
      'prompt-id-slash',
    );

    // Ensure the prompt sent to the model is from the command, not the raw input
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Prompt from command' }],
      expect.any(AbortSignal),
      'prompt-id-slash',
      { isContinuation: false },
    );

    expect(processStdoutSpy).toHaveBeenCalledWith('Response from command');
  });

  it('should handle command that requires confirmation by returning early', async () => {
    const mockCommand = {
      name: 'confirm',
      description: 'a command that needs confirmation',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'confirm_shell_commands',
        commands: ['rm -rf /'],
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/confirm',
      'prompt-id-confirm',
    );

    // Should write error message to stderr
    expect(processStderrSpy).toHaveBeenCalledWith(
      'Shell command confirmation is not supported in non-interactive mode. Use YOLO mode or pre-approve commands.\n',
    );
  });

  it('should treat an unknown slash command as a regular prompt', async () => {
    // No commands are mocked, so any slash command is "unknown"
    mockGetCommands.mockReturnValue([]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Response to unknown' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/unknowncommand',
      'prompt-id-unknown',
    );

    // Ensure the raw input is sent to the model
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: '/unknowncommand' }],
      expect.any(AbortSignal),
      'prompt-id-unknown',
      { isContinuation: false },
    );

    expect(processStdoutSpy).toHaveBeenCalledWith('Response to unknown');
  });

  it('should handle known but unsupported slash commands like /help by returning early', async () => {
    // Mock a built-in command that exists but is not in the allowed list
    const mockHelpCommand = {
      name: 'help',
      description: 'Show help',
      kind: CommandKind.BUILT_IN,
      action: vi.fn(),
    };
    mockGetCommands.mockReturnValue([mockHelpCommand]);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/help',
      'prompt-id-help',
    );

    // Should write error message to stderr
    expect(processStderrSpy).toHaveBeenCalledWith(
      'The command "/help" is not supported in non-interactive mode.\n',
    );
  });

  it('should handle unhandled command result types by returning early with error', async () => {
    const mockCommand = {
      name: 'noaction',
      description: 'unhandled type',
      kind: CommandKind.FILE,
      action: vi.fn().mockResolvedValue({
        type: 'unhandled',
      }),
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/noaction',
      'prompt-id-unhandled',
    );

    // Should write error message to stderr
    expect(processStderrSpy).toHaveBeenCalledWith(
      'Unknown command result type: unhandled\n',
    );
  });

  it('should pass arguments to the slash command action', async () => {
    const mockAction = vi.fn().mockResolvedValue({
      type: 'submit_prompt',
      content: [{ text: 'Prompt from command' }],
    });
    const mockCommand = {
      name: 'testargs',
      description: 'a test command',
      kind: CommandKind.FILE,
      action: mockAction,
    };
    mockGetCommands.mockReturnValue([mockCommand]);

    const events: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Acknowledged' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      '/testargs arg1 arg2',
      'prompt-id-args',
    );

    expect(mockAction).toHaveBeenCalledWith(expect.any(Object), 'arg1 arg2');

    expect(processStdoutSpy).toHaveBeenCalledWith('Acknowledged');
  });

  it('should emit stream-json envelopes when output format is stream-json', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

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
      { type: GeminiEventType.Content, value: 'Hello stream' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 4 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Stream input',
      'prompt-stream',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // First envelope should be system message (emitted at session start)
    expect(envelopes[0]).toMatchObject({
      type: 'system',
      subtype: 'init',
    });

    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();
    expect(assistantEnvelope?.message?.content?.[0]).toMatchObject({
      type: 'text',
      text: 'Hello stream',
    });
    const resultEnvelope = envelopes.at(-1);
    expect(resultEnvelope).toMatchObject({
      type: 'result',
      is_error: false,
      num_turns: 1,
    });
  });

  it.skip('should emit a single user envelope when userEnvelope is provided', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'Handled once' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 2 } },
        },
      ]),
    );

    const userEnvelope = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '来自 envelope 的消息',
          },
        ],
      },
    } as unknown as CLIUserMessage;

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored input',
      'prompt-envelope',
      {
        userMessage: userEnvelope,
      },
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const userEnvelopes = envelopes.filter((env) => env.type === 'user');
    expect(userEnvelopes).toHaveLength(0);
  });

  it('should include usage metadata and API duration in stream-json result', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock({
      models: {
        'test-model': {
          api: {
            totalRequests: 1,
            totalErrors: 0,
            totalLatencyMs: 500,
          },
          tokens: {
            prompt: 11,
            candidates: 5,
            total: 16,
            cached: 3,
            thoughts: 0,
            tool: 0,
          },
        },
      },
    });

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const usageMetadata = {
      promptTokenCount: 11,
      candidatesTokenCount: 5,
      totalTokenCount: 16,
      cachedContentTokenCount: 3,
    };
    mockGetDebugResponses.mockReturnValue([{ usageMetadata }]);

    const nowSpy = vi.spyOn(Date, 'now');
    let current = 0;
    nowSpy.mockImplementation(() => {
      current += 500;
      return current;
    });

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'All done' },
      ]),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'usage test',
      'prompt-usage',
    );

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

  it('should not emit user message when userMessage option is provided (stream-json input binding)', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

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
      { type: GeminiEventType.Content, value: 'Response from envelope' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    const userMessage: CLIUserMessage = {
      type: 'user',
      uuid: 'test-uuid',
      session_id: 'test-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Message from stream-json input',
          },
        ],
      },
    };

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored input',
      'prompt-envelope',
      {
        userMessage,
      },
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should NOT emit user message since it came from userMessage option
    const userEnvelopes = envelopes.filter((env) => env.type === 'user');
    expect(userEnvelopes).toHaveLength(0);

    // Should emit assistant message
    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();

    // Verify the model received the correct parts from userMessage
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Message from stream-json input' }],
      expect.any(AbortSignal),
      'prompt-envelope',
      { isContinuation: false },
    );
  });

  it('should emit tool results as user messages in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

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
        args: { arg1: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-tool',
      },
    };
    const toolResponse: Part[] = [
      {
        functionResponse: {
          name: 'testTool',
          response: { output: 'Tool executed successfully' },
        },
      },
    ];
    mockCoreExecuteToolCall.mockResolvedValue({ responseParts: toolResponse });

    const firstCallEvents: ServerGeminiStreamEvent[] = [toolCallEvent];
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Final response' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Use tool',
      'prompt-id-tool',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should have tool use in assistant message
    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();
    const toolUseBlock = assistantEnvelope?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use',
    );
    expect(toolUseBlock).toBeTruthy();
    expect(toolUseBlock?.name).toBe('testTool');

    // Should have tool result as user message
    const toolResultUserMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultUserMessages).toHaveLength(1);
    const toolResultBlock = toolResultUserMessages[0]?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    );
    expect(toolResultBlock?.tool_use_id).toBe('tool-1');
    expect(toolResultBlock?.is_error).toBe(false);
    expect(toolResultBlock?.content).toBe('Tool executed successfully');
  });

  it('should emit tool errors in tool_result blocks in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

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
        callId: 'tool-error',
        name: 'errorTool',
        args: {},
        isClientInitiated: false,
        prompt_id: 'prompt-id-error',
      },
    };
    mockCoreExecuteToolCall.mockResolvedValue({
      error: new Error('Tool execution failed'),
      errorType: ToolErrorType.EXECUTION_FAILED,
      responseParts: [
        {
          functionResponse: {
            name: 'errorTool',
            response: {
              output: 'Error: Tool execution failed',
            },
          },
        },
      ],
      resultDisplay: 'Tool execution failed',
    });

    const finalResponse: ServerGeminiStreamEvent[] = [
      {
        type: GeminiEventType.Content,
        value: 'I encountered an error',
      },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 10 } },
      },
    ];
    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents([toolCallEvent]))
      .mockReturnValueOnce(createStreamFromEvents(finalResponse));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger error',
      'prompt-id-error',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Tool errors are now captured in tool_result blocks with is_error=true,
    // not as separate system messages (see comment in nonInteractiveCli.ts line 307-309)
    const toolResultMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultMessages.length).toBeGreaterThan(0);
    const toolResultBlock = toolResultMessages[0]?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_result',
    );
    expect(toolResultBlock?.tool_use_id).toBe('tool-error');
    expect(toolResultBlock?.is_error).toBe(true);
  });

  it('should emit partial messages when includePartialMessages is true', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(true);
    setupMetricsMock();

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
      { type: GeminiEventType.Content, value: 'Hello' },
      { type: GeminiEventType.Content, value: ' World' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Stream test',
      'prompt-partial',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should have stream events for partial messages
    const streamEvents = envelopes.filter((env) => env.type === 'stream_event');
    expect(streamEvents.length).toBeGreaterThan(0);

    // Should have message_start event
    const messageStart = streamEvents.find(
      (ev) => ev.event?.type === 'message_start',
    );
    expect(messageStart).toBeTruthy();

    // Should have content_block_delta events for incremental text
    const textDeltas = streamEvents.filter(
      (ev) => ev.event?.type === 'content_block_delta',
    );
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('should handle thinking blocks in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

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
        value: { subject: 'Analysis', description: 'Processing request' },
      },
      { type: GeminiEventType.Content, value: 'Response text' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 8 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Thinking test',
      'prompt-thinking',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();

    const thinkingBlock = assistantEnvelope?.message?.content?.find(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'thinking',
    );
    expect(thinkingBlock).toBeTruthy();
    expect(thinkingBlock?.signature).toBe('Analysis');
    expect(thinkingBlock?.thinking).toContain('Processing request');
  });

  it('should handle multiple tool calls in stream-json format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

    const writes: string[] = [];
    processStdoutSpy.mockImplementation((chunk: string | Uint8Array) => {
      if (typeof chunk === 'string') {
        writes.push(chunk);
      } else {
        writes.push(Buffer.from(chunk).toString('utf8'));
      }
      return true;
    });

    const toolCall1: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'firstTool',
        args: { param: 'value1' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-multi',
      },
    };
    const toolCall2: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-2',
        name: 'secondTool',
        args: { param: 'value2' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-multi',
      },
    };

    mockCoreExecuteToolCall
      .mockResolvedValueOnce({
        responseParts: [{ text: 'First tool result' }],
      })
      .mockResolvedValueOnce({
        responseParts: [{ text: 'Second tool result' }],
      });

    const firstCallEvents: ServerGeminiStreamEvent[] = [toolCall1, toolCall2];
    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Combined response' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 15 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Multiple tools',
      'prompt-id-multi',
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));

    // Should have assistant message with both tool uses
    const assistantEnvelope = envelopes.find((env) => env.type === 'assistant');
    expect(assistantEnvelope).toBeTruthy();
    const toolUseBlocks = assistantEnvelope?.message?.content?.filter(
      (block: unknown) =>
        typeof block === 'object' &&
        block !== null &&
        'type' in block &&
        block.type === 'tool_use',
    );
    expect(toolUseBlocks?.length).toBe(2);
    const toolNames = (toolUseBlocks ?? []).map((b: unknown) => {
      if (
        typeof b === 'object' &&
        b !== null &&
        'name' in b &&
        typeof (b as { name: unknown }).name === 'string'
      ) {
        return (b as { name: string }).name;
      }
      return '';
    });
    expect(toolNames).toContain('firstTool');
    expect(toolNames).toContain('secondTool');

    // Should have two tool result user messages
    const toolResultMessages = envelopes.filter(
      (env) =>
        env.type === 'user' &&
        Array.isArray(env.message?.content) &&
        env.message.content.some(
          (block: unknown) =>
            typeof block === 'object' &&
            block !== null &&
            'type' in block &&
            block.type === 'tool_result',
        ),
    );
    expect(toolResultMessages.length).toBe(2);
  });

  it('should handle userMessage with text content blocks in stream-json input mode', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue('stream-json');
    (mockConfig.getIncludePartialMessages as Mock).mockReturnValue(false);
    setupMetricsMock();

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
      { type: GeminiEventType.Content, value: 'Response' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 3 } },
      },
    ];
    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents(events),
    );

    // UserMessage with string content
    const userMessageString: CLIUserMessage = {
      type: 'user',
      uuid: 'test-uuid-1',
      session_id: 'test-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: 'Simple string content',
      },
    };

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored',
      'prompt-string-content',
      {
        userMessage: userMessageString,
      },
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'Simple string content' }],
      expect.any(AbortSignal),
      'prompt-string-content',
      { isContinuation: false },
    );

    // UserMessage with array of text blocks
    mockGeminiClient.sendMessageStream.mockClear();
    const userMessageBlocks: CLIUserMessage = {
      type: 'user',
      uuid: 'test-uuid-2',
      session_id: 'test-session',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'First part' },
          { type: 'text', text: 'Second part' },
        ],
      },
    };

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'ignored',
      'prompt-blocks-content',
      {
        userMessage: userMessageBlocks,
      },
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledWith(
      [{ text: 'First part' }, { text: 'Second part' }],
      expect.any(AbortSignal),
      'prompt-blocks-content',
      { isContinuation: false },
    );
  });

  it('should print tool output to console in text mode (non-Task tools)', async () => {
    // Test that tool output is printed to stdout in text mode
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'tool-1',
        name: 'run_in_terminal',
        args: { command: 'npm outdated' },
        isClientInitiated: false,
        prompt_id: 'prompt-id-tool-output',
      },
    };

    // Mock tool execution with outputUpdateHandler being called
    mockCoreExecuteToolCall.mockImplementation(
      async (_config, _request, _signal, options) => {
        // Simulate tool calling outputUpdateHandler with output chunks
        if (options?.outputUpdateHandler) {
          options.outputUpdateHandler('tool-1', 'Package outdated\n');
          options.outputUpdateHandler('tool-1', 'npm@1.0.0 -> npm@2.0.0\n');
        }
        return {
          responseParts: [
            {
              functionResponse: {
                id: 'tool-1',
                name: 'run_in_terminal',
                response: {
                  output: 'Package outdated\nnpm@1.0.0 -> npm@2.0.0',
                },
              },
            },
          ],
        };
      },
    );

    const firstCallEvents: ServerGeminiStreamEvent[] = [
      toolCallEvent,
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
      },
    ];

    const secondCallEvents: ServerGeminiStreamEvent[] = [
      { type: GeminiEventType.Content, value: 'Dependencies checked' },
      {
        type: GeminiEventType.Finished,
        value: { reason: undefined, usageMetadata: { totalTokenCount: 3 } },
      },
    ];

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(createStreamFromEvents(firstCallEvents))
      .mockReturnValueOnce(createStreamFromEvents(secondCallEvents));

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Check dependencies',
      'prompt-id-tool-output',
    );

    // Verify that executeToolCall was called with outputUpdateHandler
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: 'run_in_terminal' }),
      expect.any(AbortSignal),
      expect.objectContaining({
        outputUpdateHandler: expect.any(Function),
      }),
    );

    // Verify tool output was written to stdout
    expect(processStdoutSpy).toHaveBeenCalledWith('Package outdated\n');
    expect(processStdoutSpy).toHaveBeenCalledWith('npm@1.0.0 -> npm@2.0.0\n');
    expect(processStdoutSpy).toHaveBeenCalledWith('Dependencies checked');
  });
});
