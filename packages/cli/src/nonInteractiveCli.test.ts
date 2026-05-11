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
  SendMessageType,
  ToolNames,
} from '@qwen-code/qwen-code-core';
import type { JsonOutputAdapterInterface } from './nonInteractive/io/BaseJsonOutputAdapter.js';
import type { Part } from '@google/genai';
import { runNonInteractive } from './nonInteractiveCli.js';
import { vi, type Mock, type MockInstance } from 'vitest';
import type { LoadedSettings } from './config/settings.js';
import {
  CommandKind,
  type ExecutionMode,
  type SlashCommand,
} from './ui/commands/types.js';
import { filterCommandsForMode } from './services/commandUtils.js';
import { _resetCleanupFunctionsForTest } from './utils/cleanup.js';
import {
  AlreadyReportedError,
  _resetExitLatchForTest,
} from './utils/errors.js';

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
const mockGetCommandsForMode = vi.hoisted(() => vi.fn());
const mockCommandServiceCreate = vi.hoisted(() => vi.fn());
const mockCommandServiceFromCommands = vi.hoisted(() => vi.fn());
vi.mock('./services/CommandService.js', () => ({
  CommandService: {
    create: mockCommandServiceCreate,
    fromCommands: mockCommandServiceFromCommands,
  },
}));

describe('runNonInteractive', () => {
  let mockConfig: Config;
  let mockSettings: LoadedSettings;
  let mockToolRegistry: ToolRegistry;
  let mockBackgroundTaskRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
    setRegisterCallback: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    hasUnfinalizedTasks: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
  };
  let mockMonitorRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
    setRegisterCallback: ReturnType<typeof vi.fn>;
    getRunning: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
  };
  let mockCoreExecuteToolCall: Mock;
  let mockShutdownTelemetry: Mock;
  let processStdoutSpy: MockInstance;
  let processStderrSpy: MockInstance;
  let mockGeminiClient: {
    sendMessageStream: Mock;
    getChatRecordingService: Mock;
    getChat: Mock;
    consumePendingMemoryTaskPromises: Mock;
    recordCompletedToolCall: Mock;
  };
  let mockGetDebugResponses: Mock;

  beforeEach(async () => {
    // Reset module-level state from any prior test in this file. Without
    // these resets the once-set exit latch parks subsequent JSON-mode
    // handleError tests in the never-resolving promise (5s vitest timeout).
    _resetCleanupFunctionsForTest();
    _resetExitLatchForTest();

    mockCoreExecuteToolCall = vi.mocked(executeToolCall);
    mockShutdownTelemetry = vi.mocked(shutdownTelemetry);
    mockGetCommandsForMode.mockImplementation((mode: ExecutionMode) =>
      filterCommandsForMode(mockGetCommands(), mode),
    );
    mockCommandServiceFromCommands.mockImplementation(
      (commands: readonly SlashCommand[]) => ({
        getCommands: () => commands,
        getCommandsForMode: (mode: ExecutionMode) =>
          filterCommandsForMode(commands, mode),
        getModelInvocableCommands: () =>
          commands.filter(
            (command) => !command.hidden && command.modelInvocable === true,
          ),
      }),
    );
    mockCommandServiceCreate.mockResolvedValue({
      getCommands: mockGetCommands,
      getCommandsForMode: mockGetCommandsForMode,
    });

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

    mockBackgroundTaskRegistry = {
      setNotificationCallback: vi.fn(),
      setRegisterCallback: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
      abortAll: vi.fn(),
    };

    mockMonitorRegistry = {
      setNotificationCallback: vi.fn(),
      setRegisterCallback: vi.fn(),
      getRunning: vi.fn().mockReturnValue([]),
      abortAll: vi.fn(),
    };

    mockGetDebugResponses = vi.fn(() => []);

    mockGeminiClient = {
      sendMessageStream: vi.fn(),
      consumePendingMemoryTaskPromises: vi.fn().mockReturnValue([]),
      recordCompletedToolCall: vi.fn(),
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
      getJsonSchema: vi.fn().mockReturnValue(undefined),
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
      isCronEnabled: vi.fn().mockReturnValue(false),
      getCronScheduler: vi.fn().mockReturnValue(null),
      setModelInvocableCommandsProvider: vi.fn(),
      setModelInvocableCommandsExecutor: vi.fn(),
      getAutoSkillEnabled: vi.fn().mockReturnValue(false),
      getDisabledSlashCommands: vi.fn().mockReturnValue([]),
      getBackgroundTaskRegistry: vi
        .fn()
        .mockReturnValue(mockBackgroundTaskRegistry),
      getMonitorRegistry: vi.fn().mockReturnValue(mockMonitorRegistry),
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
    setupMetricsMock();
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
      { type: SendMessageType.UserQuery },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Hello World\n');
    expect(mockShutdownTelemetry).toHaveBeenCalled();
  });

  it('on EPIPE, destroys stdout and returns normally instead of process.exit', async () => {
    // Regression: process.exit(0) on EPIPE bypassed runExitCleanup → flush()
    // and dropped queued JSONL writes for `qwen -p ... | head -1` patterns.
    // process.exit is mocked to throw in beforeEach, so reaching the
    // assertion also proves the bypass route is gone.
    setupMetricsMock();
    const stdoutDestroySpy = vi
      .spyOn(process.stdout, 'destroy')
      .mockReturnValue(process.stdout);

    mockGeminiClient.sendMessageStream.mockImplementation(
      async function* mockStream(): AsyncGenerator<ServerGeminiStreamEvent> {
        process.stdout.emit(
          'error',
          Object.assign(new Error('EPIPE'), { code: 'EPIPE' }),
        );
        yield { type: GeminiEventType.Content, value: 'Hello' };
        yield {
          type: GeminiEventType.Finished,
          value: {
            reason: undefined,
            usageMetadata: { totalTokenCount: 0 },
          },
        };
      },
    );

    await runNonInteractive(mockConfig, mockSettings, 'test', 'p1');

    expect(stdoutDestroySpy).toHaveBeenCalled();
  });

  it('should handle a single tool call and respond', async () => {
    setupMetricsMock();
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
    // Verify first call has type: UserQuery
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      1,
      [{ text: 'Use a tool' }],
      expect.any(AbortSignal),
      'prompt-id-2',
      { type: SendMessageType.UserQuery },
    );
    // Verify second call (after tool execution) has type: ToolResult
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [{ text: 'Tool response' }],
      expect.any(AbortSignal),
      'prompt-id-2',
      { type: SendMessageType.ToolResult },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Final answer\n');
    // Verify recordCompletedToolCall is called with the tool name and args.
    expect(mockGeminiClient.recordCompletedToolCall).toHaveBeenCalledWith(
      'testTool',
      { arg1: 'value1' },
    );
    // Verify consumePendingMemoryTaskPromises is called at the end of the session.
    expect(
      mockGeminiClient.consumePendingMemoryTaskPromises,
    ).toHaveBeenCalled();
  });

  it('should handle error during tool execution and should send error back to the model', async () => {
    setupMetricsMock();
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

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger tool error',
      'prompt-id-3',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalled();
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
      { type: SendMessageType.ToolResult },
    );
    expect(processStdoutSpy).toHaveBeenCalledWith('Sorry, let me try again.\n');
  });

  it('should exit with error if sendMessageStream throws initially', async () => {
    setupMetricsMock();
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
    setupMetricsMock();
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

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Trigger tool not found',
      'prompt-id-5',
    );

    expect(mockCoreExecuteToolCall).toHaveBeenCalled();
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(processStdoutSpy).toHaveBeenCalledWith(
      "Sorry, I can't find that tool.\n",
    );
  });

  it('should exit when max session turns are exceeded', async () => {
    setupMetricsMock();
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
    setupMetricsMock();
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
      { type: SendMessageType.UserQuery },
    );

    // 6. Assert the final output is correct
    expect(processStdoutSpy).toHaveBeenCalledWith('Summary complete.\n');
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
      { type: SendMessageType.UserQuery },
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
      expect.objectContaining({
        outputUpdateHandler: expect.any(Function),
      }),
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
      { type: SendMessageType.UserQuery },
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

    const jsonError = JSON.stringify(
      {
        error: {
          type: 'Error',
          message: 'Invalid input provided',
          code: 1,
        },
      },
      null,
      2,
    );
    expect(processStderrSpy).toHaveBeenCalledWith(`${jsonError}\n`);
  });

  it('should handle API errors in text mode and exit with error code', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.TEXT);
    setupMetricsMock();

    // Simulate an API error event (like 401 unauthorized)
    const apiErrorEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.Error,
      value: {
        error: {
          message: '401 Incorrect API key provided',
          status: 401,
        },
      },
    };

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([apiErrorEvent]),
    );

    let thrownError: Error | null = null;
    try {
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'Test input',
        'prompt-id-api-error',
      );
      // Should not reach here
      expect.fail('Expected error to be thrown');
    } catch (error) {
      thrownError = error as Error;
    }

    // Should throw with the API error message
    expect(thrownError).toBeTruthy();
    expect(thrownError?.message).toContain('401');
    expect(thrownError?.message).toContain('Incorrect API key provided');

    // Verify error was written to stderr
    expect(processStderrSpy).toHaveBeenCalled();
    const stderrCalls = processStderrSpy.mock.calls;
    const errorOutput = stderrCalls.map((call) => call[0]).join('');
    expect(errorOutput).toContain('401');
    expect(errorOutput).toContain('Incorrect API key provided');
  });

  it('does not double-wrap or double-format an API error in non-interactive mode', async () => {
    // Regression test for the bug where a 4xx error event flowed through
    // both the stream handler and handleError, each calling
    // parseAndFormatApiError once. The second pass would wrap the
    // already-formatted Error.message a second time, producing
    // "[API Error: [API Error: 402 ...]]" on stderr.
    //
    // We don't assert on the *number* of stderr writes here — JsonOutputAdapter
    // also emits the result message on the error path, which legitimately hits
    // stderr in TEXT mode (separate concern, separate channel). What we
    // strictly forbid is the double-wrap and any handleError-path duplicate.
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.TEXT);
    setupMetricsMock();

    const apiErrorEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.Error,
      value: {
        error: {
          message: '402 Model gpt-oss-120b is not available for billing.',
          status: 402,
        },
      },
    };

    mockGeminiClient.sendMessageStream.mockReturnValue(
      createStreamFromEvents([apiErrorEvent]),
    );

    await expect(
      runNonInteractive(
        mockConfig,
        mockSettings,
        'Test input',
        'prompt-id-double-wrap',
      ),
    ).rejects.toBeInstanceOf(AlreadyReportedError);

    const stderrOutput = processStderrSpy.mock.calls
      .map((call) => String(call[0]))
      .join('');

    // The "[API Error: [API Error:" double-wrap must never appear.
    if (stderrOutput.includes('[API Error: [API Error:')) {
      // Surface the raw bytes so a regression points at the actual offending
      // line instead of needing a debugger.
      const dump = processStderrSpy.mock.calls
        .map((call, i) => `  [${i}] ${JSON.stringify(call[0])}`)
        .join('\n');
      throw new Error(`unexpected double-wrap on stderr:\n${dump}`);
    }

    // Each formatted line ("[API Error: ...]") must contain the upstream
    // message verbatim — i.e. wrapping happens exactly once per emission.
    for (const call of processStderrSpy.mock.calls) {
      const line = String(call[0]);
      if (line.startsWith('[API Error: ')) {
        // The opening "[API Error: " should appear once; if it appears twice,
        // we have a "[API Error: [API Error: ..." line.
        expect(line.match(/\[API Error: /g)?.length ?? 0).toBe(1);
      }
    }
  });

  it('should handle FatalInputError with custom exit code in JSON format', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(OutputFormat.JSON);
    setupMetricsMock();
    const fatalError = new FatalInputError('Invalid command syntax provided');

    mockGeminiClient.sendMessageStream.mockImplementation(() => {
      throw fatalError;
    });

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

    const jsonError = JSON.stringify(
      {
        error: {
          type: 'FatalInputError',
          message: 'Invalid command syntax provided',
          code: 42,
        },
      },
      null,
      2,
    );
    expect(processStderrSpy).toHaveBeenCalledWith(`${jsonError}\n`);
  });

  it('should execute a slash command that returns a prompt', async () => {
    setupMetricsMock();
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
      { type: SendMessageType.UserQuery },
    );

    expect(processStdoutSpy).toHaveBeenCalledWith('Response from command\n');
  });

  it('should handle command that requires confirmation by returning early', async () => {
    setupMetricsMock();
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

    // Should write error message through adapter to stdout (TEXT mode goes through JsonOutputAdapter)
    expect(processStderrSpy).toHaveBeenCalledWith(
      'Shell command confirmation is not supported in non-interactive mode. Use YOLO mode or pre-approve commands.\n',
    );
  });

  it('should treat an unknown slash command as a regular prompt', async () => {
    setupMetricsMock();
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
      { type: SendMessageType.UserQuery },
    );

    expect(processStdoutSpy).toHaveBeenCalledWith('Response to unknown\n');
  });

  it('should handle known but unsupported slash commands like /help by returning early', async () => {
    setupMetricsMock();
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

    // Should write error message through adapter to stdout (TEXT mode goes through JsonOutputAdapter)
    expect(processStderrSpy).toHaveBeenCalledWith(
      'The command "/help" is not supported in this mode.\n',
    );
  });

  it('should handle unhandled command result types by returning early with error', async () => {
    setupMetricsMock();
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
    setupMetricsMock();
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

    expect(processStdoutSpy).toHaveBeenCalledWith('Acknowledged\n');
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

  it('flushes terminal monitor notifications before the final headless result', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
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

    const notificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    const cancelledXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>cancelled</status>\n' +
      '<summary>Monitor was cancelled.</summary>\n' +
      '</task-notification>';
    let monitorNotificationCallback:
      | ((
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            toolUseId?: string;
            status: 'running' | 'completed' | 'failed' | 'cancelled';
            eventCount: number;
          },
        ) => void)
      | undefined;

    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      monitorNotificationCallback = cb ?? undefined;
      if (!cb) {
        return;
      }
      cb('Monitor "logs" event #1: ready', notificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });
    mockMonitorRegistry.abortAll.mockImplementation(() => {
      monitorNotificationCallback?.(
        'Monitor "logs" was cancelled.',
        cancelledXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'cancelled',
          eventCount: 1,
        },
      );
    });

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Observed.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 1 },
            },
          },
        ]),
      );

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-monitor',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(mockGeminiClient.sendMessageStream).toHaveBeenNthCalledWith(
      2,
      [{ text: notificationXml }],
      expect.any(AbortSignal),
      'prompt-monitor',
      {
        type: SendMessageType.Notification,
        modelOverride: undefined,
        notificationDisplayText: 'Monitor "logs" event #1: ready',
      },
    );

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(
      envelopes.some(
        (env) =>
          env.type === 'system' &&
          env.subtype === 'task_notification' &&
          env.data?.task_id === 'mon_1',
      ),
    ).toBe(true);
    const cancelledNotificationIndex = envelopes.findIndex(
      (env) =>
        env.type === 'system' &&
        env.subtype === 'task_notification' &&
        env.data?.task_id === 'mon_1' &&
        env.data?.status === 'cancelled',
    );
    const resultIndex = envelopes.findIndex((env) => env.type === 'result');
    expect(cancelledNotificationIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(cancelledNotificationIndex);
    expect(mockMonitorRegistry.abortAll).toHaveBeenCalledTimes(1);
    expect(envelopes.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
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

  it('does not let late monitor output keep one-shot runs alive', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
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

    const firstNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    const secondNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #2.</summary>\n' +
      '<result>still running</result>\n' +
      '</task-notification>';
    const cancelledXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>cancelled</status>\n' +
      '<summary>Monitor was cancelled.</summary>\n' +
      '</task-notification>';

    let monitorNotificationCallback:
      | ((
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            toolUseId?: string;
            status: 'running' | 'completed' | 'failed' | 'cancelled';
            eventCount: number;
          },
        ) => void)
      | undefined;

    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      monitorNotificationCallback = cb ?? undefined;
      if (!cb) {
        return;
      }
      cb('Monitor "logs" event #1: ready', firstNotificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });
    mockMonitorRegistry.abortAll.mockImplementation(() => {
      monitorNotificationCallback?.(
        'Monitor "logs" was cancelled.',
        cancelledXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'cancelled',
          eventCount: 2,
        },
      );
    });

    async function* secondTurnStream(): AsyncGenerator<ServerGeminiStreamEvent> {
      yield { type: GeminiEventType.Content, value: 'Observed.' };
      monitorNotificationCallback?.(
        'Monitor "logs" event #2: still running',
        secondNotificationXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'running',
          eventCount: 2,
        },
      );
      yield {
        type: GeminiEventType.Finished,
        value: {
          reason: undefined,
          usageMetadata: { totalTokenCount: 1 },
        },
      };
    }

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(secondTurnStream());

    await runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-monitor-cutover',
    );

    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(2);

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    const monitorNotifications = envelopes.filter(
      (env) =>
        env.type === 'system' &&
        env.subtype === 'task_notification' &&
        env.data?.task_id === 'mon_1',
    );
    expect(
      monitorNotifications.filter((env) => env.data?.status === 'running'),
    ).toHaveLength(2);
    expect(
      monitorNotifications.some((env) => env.data?.status === 'cancelled'),
    ).toBe(true);
    expect(envelopes.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
    });
  });

  it('streams late monitor output to the SDK before one-shot completion', async () => {
    (mockConfig.getOutputFormat as Mock).mockReturnValue(
      OutputFormat.STREAM_JSON,
    );
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

    let keepBackgroundTaskOpen = true;
    let lateMonitorEventEmitted = false;
    mockBackgroundTaskRegistry.hasUnfinalizedTasks.mockImplementation(() => {
      if (keepBackgroundTaskOpen && !lateMonitorEventEmitted) {
        lateMonitorEventEmitted = true;
        monitorNotificationCallback?.(
          'Monitor "logs" event #2: still running',
          secondNotificationXml,
          {
            monitorId: 'mon_1',
            toolUseId: 'tool_mon_1',
            status: 'running',
            eventCount: 2,
          },
        );
      }
      return keepBackgroundTaskOpen;
    });

    const firstNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #1.</summary>\n' +
      '<result>ready</result>\n' +
      '</task-notification>';
    const secondNotificationXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>running</status>\n' +
      '<summary>Monitor emitted event #2.</summary>\n' +
      '<result>still running</result>\n' +
      '</task-notification>';
    const cancelledXml =
      '<task-notification>\n' +
      '<task-id>mon_1</task-id>\n' +
      '<kind>monitor</kind>\n' +
      '<status>cancelled</status>\n' +
      '<summary>Monitor was cancelled.</summary>\n' +
      '</task-notification>';

    let monitorNotificationCallback:
      | ((
          displayText: string,
          modelText: string,
          meta: {
            monitorId: string;
            toolUseId?: string;
            status: 'running' | 'completed' | 'failed' | 'cancelled';
            eventCount: number;
          },
        ) => void)
      | undefined;

    mockMonitorRegistry.setNotificationCallback.mockImplementation((cb) => {
      monitorNotificationCallback = cb ?? undefined;
      if (!cb) {
        return;
      }
      cb('Monitor "logs" event #1: ready', firstNotificationXml, {
        monitorId: 'mon_1',
        toolUseId: 'tool_mon_1',
        status: 'running',
        eventCount: 1,
      });
    });
    mockMonitorRegistry.abortAll.mockImplementation(() => {
      monitorNotificationCallback?.(
        'Monitor "logs" was cancelled.',
        cancelledXml,
        {
          monitorId: 'mon_1',
          toolUseId: 'tool_mon_1',
          status: 'cancelled',
          eventCount: 2,
        },
      );
    });

    mockGeminiClient.sendMessageStream
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Monitor launched.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 2 },
            },
          },
        ]),
      )
      .mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'Observed.' },
          {
            type: GeminiEventType.Finished,
            value: {
              reason: undefined,
              usageMetadata: { totalTokenCount: 1 },
            },
          },
        ]),
      );

    const runPromise = runNonInteractive(
      mockConfig,
      mockSettings,
      'Watch the logs',
      'prompt-monitor-late-sdk',
    );

    await vi.waitFor(() => {
      const envelopes = writes
        .join('')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line));
      const monitorNotifications = envelopes.filter(
        (env) =>
          env.type === 'system' &&
          env.subtype === 'task_notification' &&
          env.data?.task_id === 'mon_1',
      );

      expect(
        monitorNotifications.filter((env) => env.data?.status === 'running'),
      ).toHaveLength(2);
      expect(envelopes.some((env) => env.type === 'result')).toBe(false);
    });

    keepBackgroundTaskOpen = false;
    await runPromise;

    const envelopes = writes
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    expect(envelopes.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
    });
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
          },
          bySource: {},
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
      { type: SendMessageType.UserQuery },
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
      { type: SendMessageType.UserQuery },
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
      { type: SendMessageType.UserQuery },
    );
  });

  // ---- --json-schema (structured_output) contract --------------------
  // These two cover the runtime branches gpt-5.5 review S8 flagged as
  // missing test coverage. We mock the LLM at sendMessageStream so the
  // assertions are deterministic; the L2 integration tests in
  // integration-tests/cli/json-schema.test.ts run the same flow against
  // a real model as smoke coverage.

  function makeMockAdapter(): JsonOutputAdapterInterface {
    return {
      startAssistantMessage: vi.fn(),
      processEvent: vi.fn(),
      finalizeAssistantMessage: vi.fn().mockReturnValue({
        type: 'assistant',
        uuid: 'mock-uuid',
        session_id: 'test-session-id',
        parent_tool_use_id: null,
        message: {
          id: 'mock-uuid',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      emitResult: vi.fn(),
      emitMessage: vi.fn(),
      emitUserMessage: vi.fn(),
      emitToolResult: vi.fn(),
      emitSystemMessage: vi.fn(),
      emitToolProgress: vi.fn(),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getModel: vi.fn().mockReturnValue('test-model'),
    } as unknown as JsonOutputAdapterInterface;
  }

  it('emits structuredResult and stops when structured_output is called under --json-schema', async () => {
    setupMetricsMock();
    vi.mocked(mockConfig.getJsonSchema).mockReturnValue({
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    });

    // Single turn: model fires the synthetic structured_output tool with
    // its final payload as args, then Finished. No follow-up turn should
    // run — runNonInteractive's structured-output branch returns early.
    const toolCallEvent: ServerGeminiStreamEvent = {
      type: GeminiEventType.ToolCallRequest,
      value: {
        callId: 'so-1',
        name: ToolNames.STRUCTURED_OUTPUT,
        args: { answer: 42 },
        isClientInitiated: false,
        prompt_id: 'p-structured-success',
      },
    };
    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        toolCallEvent,
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 5 } },
        },
      ]),
    );
    // No error → runtime sets structuredSubmission and terminates.
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'Structured output accepted.' }],
    });

    const adapter = makeMockAdapter();
    await runNonInteractive(
      mockConfig,
      mockSettings,
      'compute 21*2',
      'p-structured-success',
      { adapter },
    );

    // Single-shot contract: no follow-up turn was issued.
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(1);
    // Background tasks aborted so they don't race the terminal emitResult.
    expect(mockBackgroundTaskRegistry.abortAll).toHaveBeenCalledTimes(1);
    // structuredResult lands in the result message exactly as the model
    // submitted it (no schema massaging at the runtime layer).
    expect(adapter.emitResult).toHaveBeenCalledTimes(1);
    expect(adapter.emitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: false,
        structuredResult: { answer: 42 },
        numTurns: 1,
      }),
    );
  });

  it('skips remaining tool calls in the same batch after structured_output succeeds', async () => {
    // Single-shot contract: a model emitting
    // `[structured_output(...), write_file(...)]` in the same response
    // must not have write_file run after structured_output records.
    // This test pins the break-after-success path; structured_output
    // is at index 0 so the pre-scan reorder is a no-op here. See
    // sibling test "reorders structured_output before side-effect tools"
    // for the reorder coverage.
    setupMetricsMock();
    vi.mocked(mockConfig.getJsonSchema).mockReturnValue({
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    });

    const sideEffectCallId = 'write-1';
    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: 'so-batch',
            name: ToolNames.STRUCTURED_OUTPUT,
            args: { answer: 7 },
            isClientInitiated: false,
            prompt_id: 'p-batch',
          },
        },
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: sideEffectCallId,
            name: 'write_file',
            args: { path: '/tmp/should-not-run', content: 'side effect' },
            isClientInitiated: false,
            prompt_id: 'p-batch',
          },
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'Structured output accepted.' }],
    });

    const adapter = makeMockAdapter();
    await runNonInteractive(mockConfig, mockSettings, 'go', 'p-batch', {
      adapter,
    });

    // executeToolCall called exactly once — for structured_output.
    // write_file would be the second call if the loop hadn't broken.
    expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({ name: ToolNames.STRUCTURED_OUTPUT }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    // emitResult landed; side-effect tool name should not appear in any
    // emitToolResult call.
    expect(adapter.emitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: false,
        structuredResult: { answer: 7 },
      }),
    );
    const toolResultCalls = vi.mocked(adapter.emitToolResult).mock.calls;
    const sideEffectEmitted = toolResultCalls.some(
      ([req]) => req.callId === sideEffectCallId,
    );
    expect(sideEffectEmitted).toBe(false);
  });

  it('reorders structured_output before side-effect tools so siblings never run', async () => {
    // Pre-scan: when --json-schema is active and the model emitted
    // [write_file, structured_output] (struct NOT first), the pre-scan
    // must hoist structured_output to position 0 and then the
    // break-after-success path skips write_file entirely. Without the
    // pre-scan, write_file would persist its side effect BEFORE
    // structured_output's terminal flag fired.
    setupMetricsMock();
    vi.mocked(mockConfig.getJsonSchema).mockReturnValue({
      type: 'object',
      properties: { answer: { type: 'number' } },
    });

    const writeFileCallId = 'write-pre-1';
    const structuredCallId = 'so-pre-1';
    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        // Order matters: write_file FIRST, structured_output second.
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: writeFileCallId,
            name: 'write_file',
            args: { path: '/tmp/should-not-run', content: 'side effect' },
            isClientInitiated: false,
            prompt_id: 'p-prescan',
          },
        },
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: structuredCallId,
            name: ToolNames.STRUCTURED_OUTPUT,
            args: { answer: 1 },
            isClientInitiated: false,
            prompt_id: 'p-prescan',
          },
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'Structured output accepted.' }],
    });

    const adapter = makeMockAdapter();
    await runNonInteractive(mockConfig, mockSettings, 'go', 'p-prescan', {
      adapter,
    });

    // Exactly ONE executeToolCall — for structured_output. write_file
    // never runs because the pre-scan moved it after structured_output
    // and the break-after-success path skipped it.
    expect(mockCoreExecuteToolCall).toHaveBeenCalledTimes(1);
    expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
      mockConfig,
      expect.objectContaining({
        name: ToolNames.STRUCTURED_OUTPUT,
        callId: structuredCallId,
      }),
      expect.any(AbortSignal),
      expect.any(Object),
    );
    expect(adapter.emitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: false,
        structuredResult: { answer: 1 },
      }),
    );
    // No tool_result emitted for write_file: it never executed.
    const toolResultCalls = vi.mocked(adapter.emitToolResult).mock.calls;
    expect(
      toolResultCalls.some(([req]) => req.callId === writeFileCallId),
    ).toBe(false);
  });

  it('lets siblings run when structured_output validation fails so the model can retry', async () => {
    // Validation-failure fallback: if structured_output execute() fails
    // (e.g. arg validation rejected the payload), `hasStructuredSubmission`
    // stays false and the loop continues normally — sibling tools in the
    // batch SHOULD run, same as a turn that didn't issue structured_output
    // at all. The model gets the validation error in the tool_result and
    // can retry next turn.
    setupMetricsMock();
    vi.mocked(mockConfig.getJsonSchema).mockReturnValue({
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'number' } },
    });

    const writeFileCallId = 'write-fallback';
    const structuredCallId = 'so-fail';
    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: structuredCallId,
            name: ToolNames.STRUCTURED_OUTPUT,
            args: { answer: 'not-a-number' },
            isClientInitiated: false,
            prompt_id: 'p-fallback',
          },
        },
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: writeFileCallId,
            name: 'write_file',
            args: { path: '/tmp/x', content: 'sibling' },
            isClientInitiated: false,
            prompt_id: 'p-fallback',
          },
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    // Second turn (after the sibling tool ran) — model gives up cleanly
    // by emitting plain text so the run terminates without
    // hasStructuredSubmission ever flipping.
    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        { type: GeminiEventType.Content, value: 'gave up' },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    // structured_output → error; write_file → success.
    mockCoreExecuteToolCall.mockImplementation(async (_cfg, req) => {
      if (req.name === ToolNames.STRUCTURED_OUTPUT) {
        return {
          responseParts: [{ text: 'validation error' }],
          error: new Error('Schema validation failed'),
          errorType: 'TOOL_EXECUTION_ERROR',
        } as never;
      }
      return { responseParts: [{ text: 'wrote' }] } as never;
    });

    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const adapter = makeMockAdapter();
      await runNonInteractive(mockConfig, mockSettings, 'go', 'p-fallback', {
        adapter,
      });

      // Both tools executed (one successfully, one failed). The
      // critical assertion is that the sibling DID run — fallback
      // semantics are restored when structured_output fails.
      expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ name: ToolNames.STRUCTURED_OUTPUT }),
        expect.any(AbortSignal),
        expect.any(Object),
      );
      expect(mockCoreExecuteToolCall).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ name: 'write_file' }),
        expect.any(AbortSignal),
        expect.any(Object),
      );
      // No structuredResult emitted — the failure didn't terminate via
      // the success branch. The plain-text terminal branch fires
      // instead (model gave up on turn 2).
      const resultCalls = vi.mocked(adapter.emitResult).mock.calls;
      const successCall = resultCalls.find(
        ([opts]) =>
          'structuredResult' in (opts as Record<string, unknown>) &&
          !(opts as { isError?: boolean }).isError,
      );
      expect(successCall).toBeUndefined();
    } finally {
      process.exitCode = priorExitCode;
    }
  });

  it('terminates even when structured_output args are undefined under an empty schema', async () => {
    // Pin the boolean-sentinel contract: the previous
    // `structuredSubmission !== undefined` check broke if the model
    // called structured_output with args missing/undefined (which can
    // happen under a permissive `{}` schema, since validateToolParams
    // would have already accepted the call). The run must still
    // terminate on the first successful structured_output call.
    setupMetricsMock();
    vi.mocked(mockConfig.getJsonSchema).mockReturnValue({});

    mockGeminiClient.sendMessageStream.mockReturnValueOnce(
      createStreamFromEvents([
        {
          type: GeminiEventType.ToolCallRequest,
          value: {
            callId: 'so-undef',
            name: ToolNames.STRUCTURED_OUTPUT,
            args: undefined as unknown as Record<string, unknown>,
            isClientInitiated: false,
            prompt_id: 'p-structured-undef',
          },
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
        },
      ]),
    );
    mockCoreExecuteToolCall.mockResolvedValue({
      responseParts: [{ text: 'Structured output accepted.' }],
    });

    const adapter = makeMockAdapter();
    await runNonInteractive(
      mockConfig,
      mockSettings,
      'go',
      'p-structured-undef',
      { adapter },
    );

    // Single turn — boolean sentinel kicked us out even though the args
    // value itself is undefined.
    expect(mockGeminiClient.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(adapter.emitResult).toHaveBeenCalledTimes(1);
    expect(adapter.emitResult).toHaveBeenCalledWith(
      expect.objectContaining({
        isError: false,
        structuredResult: undefined,
      }),
    );
  });

  it('sets process.exitCode=1 and writes stderr when model emits text under --json-schema', async () => {
    setupMetricsMock();
    vi.mocked(mockConfig.getJsonSchema).mockReturnValue({
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    });

    // Snapshot/restore the global so a stray exitCode=1 doesn't bleed into
    // sibling tests in the file.
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      mockGeminiClient.sendMessageStream.mockReturnValueOnce(
        createStreamFromEvents([
          { type: GeminiEventType.Content, value: 'plain answer' },
          {
            type: GeminiEventType.Finished,
            value: { reason: undefined, usageMetadata: { totalTokenCount: 1 } },
          },
        ]),
      );

      const adapter = makeMockAdapter();
      await runNonInteractive(
        mockConfig,
        mockSettings,
        'q',
        'p-structured-text',
        { adapter },
      );

      expect(process.exitCode).toBe(1);
      // adapter sees the contract violation as an error result, with
      // diagnostic context: turn count + truncated preview of model's
      // plain-text output ("plain answer" from the mocked stream).
      // The adapter is responsible for surfacing the message per output
      // format (TEXT → stderr; JSON / STREAM_JSON → structured result);
      // runNonInteractive no longer writes a duplicate stderr line.
      expect(adapter.emitResult).toHaveBeenCalledTimes(1);
      expect(adapter.emitResult).toHaveBeenCalledWith(
        expect.objectContaining({
          isError: true,
          errorMessage: expect.stringMatching(
            /Model produced plain text.+after 1 turn\(s\).+Output preview.+plain answer/s,
          ),
        }),
      );
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
