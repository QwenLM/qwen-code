/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { logs } from '@opentelemetry/api-logs';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type {
  AnyToolInvocation,
  CompletedToolCall,
  ContentGeneratorConfig,
  ErroredToolCall,
} from '../index.js';
import {
  AuthType,
  GeminiClient,
  ToolConfirmationOutcome,
  ToolErrorType,
  ToolRegistry,
} from '../index.js';
import { EditTool } from '../tools/edit.js';
import { OutputFormat } from '../output/types.js';
import {
  EVENT_API_REQUEST,
  EVENT_API_RESPONSE,
  EVENT_CLI_CONFIG,
  EVENT_FLASH_FALLBACK,
  EVENT_TOOL_CALL,
  EVENT_USER_PROMPT,
  EVENT_MALFORMED_JSON_RESPONSE,
  EVENT_FILE_OPERATION,
  EVENT_RIPGREP_FALLBACK,
  EVENT_RIPGREP_RUNTIME_RECOVERY,
  EVENT_SKILL_LAUNCH,
  EVENT_EXTENSION_ENABLE,
  EVENT_EXTENSION_DISABLE,
  EVENT_EXTENSION_INSTALL,
  EVENT_EXTENSION_UNINSTALL,
  EVENT_TOOL_OUTPUT_TRUNCATED,
  EVENT_PROTOCOL_TAG_SANITIZED,
  EVENT_MEMORY_RECALL_DELIVERY,
} from './constants.js';
import {
  logApiRequest,
  logApiResponse,
  logStartSession,
  logUserPrompt,
  logToolCall,
  logFlashFallback,
  logChatCompression,
  logMalformedJsonResponse,
  logFileOperation,
  logRipgrepFallback,
  logRipgrepRuntimeRecovery,
  logSkillLaunch,
  logToolOutputTruncated,
  logExtensionEnable,
  logExtensionDisable,
  logExtensionInstallEvent,
  logExtensionUninstall,
  logHookCall,
  logApiError,
  logApiRetry,
  logProtocolTagSanitized,
  logMemoryRecallDelivery,
  normalizeToolCallEvent,
} from './loggers.js';
import * as metrics from './metrics.js';
import { apiActivityTracker } from './api-activity-tracker.js';
import { QwenLogger } from './qwen-logger/qwen-logger.js';
import * as sdk from './sdk.js';
import * as tokenUsageService from '../services/tokenUsageService.js';
import { ToolCallDecision } from './tool-call-decision.js';
import {
  ApiRequestEvent,
  ApiResponseEvent,
  FlashFallbackEvent,
  StartSessionEvent,
  ToolCallEvent,
  UserPromptEvent,
  RipgrepFallbackEvent,
  RipgrepRuntimeRecoveryEvent,
  SkillLaunchEvent,
  MalformedJsonResponseEvent,
  makeChatCompressionEvent,
  FileOperationEvent,
  ToolOutputTruncatedEvent,
  ExtensionEnableEvent,
  ExtensionDisableEvent,
  ExtensionInstallEvent,
  ExtensionUninstallEvent,
  HookCallEvent,
  ApiErrorEvent,
  ApiRetryEvent,
  ProtocolTagSanitizedEvent,
  MemoryRecallDeliveryEvent,
} from './types.js';
import { FileOperation } from './metrics.js';
import type {
  CallableTool,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import * as uiTelemetry from './uiTelemetry.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { runWithChatRecordingSuppressed } from '../utils/chat-recording-suppression-context.js';

describe('loggers', () => {
  const mockLogger = {
    emit: vi.fn(),
  };
  const mockUiEvent = {
    addEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(true);
    vi.spyOn(logs, 'getLogger').mockReturnValue(mockLogger);
    vi.spyOn(uiTelemetry.uiTelemetryService, 'addEvent').mockImplementation(
      mockUiEvent.addEvent,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('logChatCompression', () => {
    beforeEach(() => {
      vi.spyOn(metrics, 'recordChatCompressionMetrics');
      vi.spyOn(QwenLogger.prototype, 'logChatCompressionEvent');
    });

    it('logs the chat compression event to QwenLogger', () => {
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });

      const event = makeChatCompressionEvent({
        tokens_before: 9001,
        tokens_after: 9000,
        cache_sharing_attempted: true,
        cache_sharing_used: false,
      });

      logChatCompression(mockConfig, event);

      expect(QwenLogger.prototype.logChatCompressionEvent).toHaveBeenCalledWith(
        event,
      );
    });

    it('records the chat compression event to OTEL', () => {
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });

      logChatCompression(
        mockConfig,
        makeChatCompressionEvent({
          tokens_before: 9001,
          tokens_after: 9000,
        }),
      );

      expect(metrics.recordChatCompressionMetrics).toHaveBeenCalledWith(
        mockConfig,
        { tokens_before: 9001, tokens_after: 9000 },
      );
    });
  });

  describe('logProtocolTagSanitized', () => {
    it('emits a privacy-safe handled event to QwenLogger and OpenTelemetry', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      vi.spyOn(QwenLogger.prototype, 'logProtocolTagSanitizedEvent');
      const event = new ProtocolTagSanitizedEvent({
        model: 'test-model',
        promptId: 'prompt-id',
        responseId: 'response-id',
        tagName: 'think',
        toolCallCount: 2,
      });

      logProtocolTagSanitized(config, event);

      expect(
        QwenLogger.prototype.logProtocolTagSanitizedEvent,
      ).toHaveBeenCalledWith(event);
      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Suppressed a standalone closing think tag and preserved 2 tool call(s).',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_PROTOCOL_TAG_SANITIZED,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          model: 'test-model',
          prompt_id: 'prompt-id',
          response_id: 'response-id',
          tag_name: 'think',
          tool_call_count: 2,
        },
      });
      expect(JSON.stringify(mockLogger.emit.mock.calls[0])).not.toMatch(
        /response_text|reasoning|tool_name|arguments/,
      );
    });
  });

  describe('logMemoryRecallDelivery', () => {
    beforeEach(() => {
      vi.spyOn(metrics, 'recordMemoryRecallDeliveryMetrics');
    });

    it('emits low-cardinality delivery telemetry without memory content or paths', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = new MemoryRecallDeliveryEvent({
        phase: 'refined',
        delivery_point: 'discarded',
        discard_reason: 'reset',
        strategy: 'model',
        docs_selected: 2,
        latency_ms: 123,
      });

      logMemoryRecallDelivery(config, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Memory recall delivery: phase=refined. delivery_point=discarded. Selected 2 doc(s).',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_MEMORY_RECALL_DELIVERY,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          phase: 'refined',
          delivery_point: 'discarded',
          discard_reason: 'reset',
          strategy: 'model',
          docs_selected: 2,
          latency_ms: 123,
        },
      });
      expect(mockLogger.emit.mock.calls[0][0].attributes).toHaveProperty(
        'session.id',
        'test-session-id',
      );
      expect(metrics.recordMemoryRecallDeliveryMetrics).toHaveBeenCalledWith(
        config,
        123,
        {
          phase: 'refined',
          delivery_point: 'discarded',
          discard_reason: 'reset',
          strategy: 'model',
        },
      );
      expect(JSON.stringify(mockLogger.emit.mock.calls[0])).not.toMatch(
        /query|hash|content|filePath|projectPath|message|raw_error|secret/i,
      );
    });

    it('omits discard_reason from metrics payload for delivered memory', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = new MemoryRecallDeliveryEvent({
        phase: 'refined',
        delivery_point: 'tool_result',
        strategy: 'model',
        docs_selected: 2,
        latency_ms: 123,
      });

      logMemoryRecallDelivery(config, event);

      expect(metrics.recordMemoryRecallDeliveryMetrics).toHaveBeenCalledWith(
        config,
        123,
        {
          phase: 'refined',
          delivery_point: 'tool_result',
          strategy: 'model',
        },
      );
    });
  });

  describe('logCliConfiguration', () => {
    it('should log the cli configuration', () => {
      const mockConfig = {
        getSessionId: () => 'test-session-id',
        getModel: () => 'test-model',
        getSandbox: () => true,
        getCoreTools: () => ['ls', 'read-file'],
        getApprovalMode: () => 'default',
        getTruncateToolOutputThreshold: () => 25000,
        getTruncateToolOutputLines: () => 1000,
        getTelemetryEnabled: () => true,
        getUsageStatisticsEnabled: () => true,
        getTelemetryLogPromptsEnabled: () => true,
        getFileFilteringRespectGitIgnore: () => true,
        getFileFilteringAllowBuildArtifacts: () => false,
        getDebugMode: () => true,
        getMcpServers: () => ({
          'test-server': {
            command: 'test-command',
          },
        }),
        getQuestion: () => 'test-question',
        getTargetDir: () => 'target-dir',
        getProxy: () => 'http://test.proxy.com:8080',
        getOutputFormat: () => OutputFormat.JSON,
        getToolRegistry: () => undefined,
        getChatRecordingService: () => undefined,
        getHookSystem: () => undefined,
        getIdeMode: () => false,
        getShouldUseNodePtyShell: () => true,
      } as unknown as Config;

      const startSessionEvent = new StartSessionEvent(mockConfig);
      logStartSession(mockConfig, startSessionEvent);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'CLI configuration loaded.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_CLI_CONFIG,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          model: 'test-model',
          sandbox_enabled: true,
          core_tools_enabled: 'ls,read-file',
          approval_mode: 'default',
          truncate_tool_output_threshold: 25000,
          truncate_tool_output_lines: 1000,
          file_filtering_respect_git_ignore: true,
          debug_mode: true,
          mcp_servers: 'test-server',
          mcp_servers_count: 1,
          mcp_tools: undefined,
          mcp_tools_count: undefined,
          hooks: undefined,
          ide_enabled: false,
          interactive_shell_enabled: true,
          output_format: 'json',
          skills: undefined,
          subagents: undefined,
        },
      });
    });
  });

  describe('logUserPrompt', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    it('should log a user prompt', () => {
      const event = new UserPromptEvent(
        11,
        'prompt-id-8',
        AuthType.USE_VERTEX_AI,
        'test-prompt',
      );

      logUserPrompt(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'User prompt. Length: 11.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_USER_PROMPT,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          prompt_length: 11,
          prompt: 'test-prompt',
          prompt_id: 'prompt-id-8',
          auth_type: 'vertex-ai',
        },
      });
    });

    it('should include the model attribute when set (e.g. inline override)', () => {
      const event = new UserPromptEvent(
        11,
        'prompt-id-model',
        AuthType.USE_OPENAI,
        'test-prompt',
        'qwen-max',
      );

      logUserPrompt(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'User prompt. Length: 11.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_USER_PROMPT,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          prompt_length: 11,
          prompt: 'test-prompt',
          prompt_id: 'prompt-id-model',
          auth_type: 'openai',
          model: 'qwen-max',
        },
      });
    });

    it('should not log prompt if disabled', () => {
      const mockConfig = {
        getSessionId: () => 'test-session-id',
        getTelemetryEnabled: () => true,
        getTelemetryLogPromptsEnabled: () => false,
        getTargetDir: () => 'target-dir',
        getUsageStatisticsEnabled: () => true,
      } as unknown as Config;
      const event = new UserPromptEvent(
        11,
        'prompt-id-9',
        AuthType.USE_GEMINI,
        'test-prompt',
      );

      logUserPrompt(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'User prompt. Length: 11.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_USER_PROMPT,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          prompt_length: 11,
          prompt_id: 'prompt-id-9',
          auth_type: 'gemini',
        },
      });
    });
  });

  describe('logApiResponse', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getUsageStatisticsEnabled: () => true,
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
      getChatRecordingService: () => undefined,
    } as unknown as Config;

    const mockMetrics = {
      recordApiResponseMetrics: vi.fn(),
      recordTokenUsageMetrics: vi.fn(),
    };

    beforeEach(() => {
      vi.spyOn(metrics, 'recordApiResponseMetrics').mockImplementation(
        mockMetrics.recordApiResponseMetrics,
      );
      vi.spyOn(metrics, 'recordTokenUsageMetrics').mockImplementation(
        mockMetrics.recordTokenUsageMetrics,
      );
      vi.spyOn(
        tokenUsageService,
        'recordTokenUsageFromApiResponseBestEffort',
      ).mockImplementation(() => undefined);
    });

    it('should log an API response with all fields', () => {
      const usageData: GenerateContentResponseUsageMetadata = {
        promptTokenCount: 17,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 5,
      };
      const event = new ApiResponseEvent(
        'test-response-id',
        'test-model',
        100,
        'prompt-id-1',
        AuthType.USE_GEMINI,
        usageData,
        'test-response',
      );

      logApiResponse(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'API response from test-model. Status: 200. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_API_RESPONSE,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          [SemanticAttributes.HTTP_STATUS_CODE]: 200,
          response_id: 'test-response-id',
          model: 'test-model',
          status_code: 200,
          duration_ms: 100,
          input_token_count: 17,
          output_token_count: 50,
          cached_content_token_count: 10,
          thoughts_token_count: 5,
          total_token_count: 0,
          response_text: 'test-response',
          prompt_id: 'prompt-id-1',
          auth_type: 'gemini',
        },
      });

      expect(mockMetrics.recordApiResponseMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        { model: 'test-model', status_code: 200 },
      );

      expect(mockMetrics.recordTokenUsageMetrics).toHaveBeenCalledWith(
        mockConfig,
        50,
        { model: 'test-model', type: 'output' },
      );

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...event,
          'event.name': EVENT_API_RESPONSE,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
        },
        'test-session-id',
      );
      expect(
        tokenUsageService.recordTokenUsageFromApiResponseBestEffort,
      ).toHaveBeenCalledWith(mockConfig, event);
    });

    it.each([
      'prompt_suggestion',
      'forked_query',
      'speculation',
      'side-query:session-title',
    ])('does not record token usage for internal prompt_id %s', (promptId) => {
      const event = new ApiResponseEvent(
        'test-response-id',
        'test-model',
        100,
        promptId,
        AuthType.USE_GEMINI,
        {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
        },
      );

      logApiResponse(mockConfig, event);

      expect(
        tokenUsageService.recordTokenUsageFromApiResponseBestEffort,
      ).not.toHaveBeenCalled();
    });

    it('does not record token usage when usage statistics are disabled', () => {
      const configWithUsageStatsDisabled = {
        ...mockConfig,
        getUsageStatisticsEnabled: () => false,
      } as unknown as Config;
      const event = new ApiResponseEvent(
        'test-response-id',
        'test-model',
        100,
        'prompt-id-1',
        AuthType.USE_GEMINI,
        {
          promptTokenCount: 1,
          candidatesTokenCount: 2,
        },
      );

      logApiResponse(configWithUsageStatsDisabled, event);

      expect(
        tokenUsageService.recordTokenUsageFromApiResponseBestEffort,
      ).not.toHaveBeenCalled();
    });
  });

  describe('logApiResponse skips chatRecordingService for internal prompt IDs', () => {
    it.each([
      'prompt_suggestion',
      'forked_query',
      'speculation',
      'side-query:session-title',
    ])(
      'should not record to chatRecordingService when prompt_id is %s',
      (promptId) => {
        const mockRecordUiTelemetryEvent = vi.fn();
        const configWithRecording = {
          getSessionId: () => 'test-session-id',
          getUsageStatisticsEnabled: () => false,
          getChatRecordingService: () => ({
            recordUiTelemetryEvent: mockRecordUiTelemetryEvent,
          }),
        } as unknown as Config;

        const event = new ApiResponseEvent(
          'resp-id',
          'test-model',
          50,
          promptId,
        );
        logApiResponse(configWithRecording, event);

        expect(mockRecordUiTelemetryEvent).not.toHaveBeenCalled();
        expect(mockUiEvent.addEvent).toHaveBeenCalled();
      },
    );

    it('should record to chatRecordingService for normal prompt IDs', () => {
      const mockRecordUiTelemetryEvent = vi.fn();
      const configWithRecording = {
        getSessionId: () => 'test-session-id',
        getUsageStatisticsEnabled: () => false,
        getChatRecordingService: () => ({
          recordUiTelemetryEvent: mockRecordUiTelemetryEvent,
        }),
      } as unknown as Config;

      const event = new ApiResponseEvent(
        'resp-id',
        'test-model',
        50,
        'user_query',
      );
      logApiResponse(configWithRecording, event);

      expect(mockRecordUiTelemetryEvent).toHaveBeenCalled();
    });

    it('suppresses chatRecordingService writes inside hidden runs', () => {
      const mockRecordUiTelemetryEvent = vi.fn();
      const configWithRecording = {
        getSessionId: () => 'test-session-id',
        getUsageStatisticsEnabled: () => false,
        getChatRecordingService: () => ({
          recordUiTelemetryEvent: mockRecordUiTelemetryEvent,
        }),
      } as unknown as Config;

      const event = new ApiResponseEvent(
        'resp-id',
        'test-model',
        50,
        'user_query',
      );
      runWithChatRecordingSuppressed(() => {
        logApiResponse(configWithRecording, event);
      });

      expect(mockRecordUiTelemetryEvent).not.toHaveBeenCalled();
      expect(mockUiEvent.addEvent).toHaveBeenCalled();
    });
  });

  describe('logApiError skips chatRecordingService for internal prompt IDs', () => {
    it.each(['prompt_suggestion', 'forked_query', 'speculation'])(
      'should not record to chatRecordingService when prompt_id is %s',
      (promptId) => {
        const mockRecordUiTelemetryEvent = vi.fn();
        const configWithRecording = {
          getSessionId: () => 'test-session-id',
          getUsageStatisticsEnabled: () => false,
          getChatRecordingService: () => ({
            recordUiTelemetryEvent: mockRecordUiTelemetryEvent,
          }),
        } as unknown as Config;

        const event = new ApiErrorEvent({
          model: 'test-model',
          durationMs: 100,
          promptId,
          errorMessage: 'test error',
        });
        logApiError(configWithRecording, event);

        expect(mockRecordUiTelemetryEvent).not.toHaveBeenCalled();
      },
    );

    it('should record to chatRecordingService for normal prompt IDs', () => {
      const mockRecordUiTelemetryEvent = vi.fn();
      const configWithRecording = {
        getSessionId: () => 'test-session-id',
        getUsageStatisticsEnabled: () => false,
        getChatRecordingService: () => ({
          recordUiTelemetryEvent: mockRecordUiTelemetryEvent,
        }),
      } as unknown as Config;

      const event = new ApiErrorEvent({
        model: 'test-model',
        durationMs: 100,
        promptId: 'user_query',
        errorMessage: 'test error',
      });
      logApiError(configWithRecording, event);

      expect(mockRecordUiTelemetryEvent).toHaveBeenCalled();
    });

    it('increments the api-activity error counter for the daemon health chart', () => {
      apiActivityTracker.drain(); // isolate from other cases (global singleton)
      const event = new ApiErrorEvent({
        model: 'test-model',
        durationMs: 100,
        promptId: 'user_query',
        errorMessage: 'boom',
      });
      logApiError(makeFakeConfig({ sessionId: 'test-session-id' }), event);
      expect(apiActivityTracker.peek()).toEqual({ errors: 1, retries: 0 });
    });

    it('counts the error even when the OTel SDK is not initialized', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      apiActivityTracker.drain();
      const event = new ApiErrorEvent({
        model: 'test-model',
        durationMs: 100,
        promptId: 'user_query',
        errorMessage: 'boom',
      });
      logApiError(makeFakeConfig({ sessionId: 's' }), event);
      // The daemon health chart is independent of OTel export state — the
      // counter is bumped before the SDK guard, mirroring logApiRetry.
      expect(apiActivityTracker.peek().errors).toBe(1);
    });
  });

  describe('logApiRequest', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getUsageStatisticsEnabled: () => true,
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
    } as unknown as Config;

    it('should log an API request with request_text', () => {
      const event = new ApiRequestEvent(
        'test-model',
        'prompt-id-7',
        'This is a test request',
      );

      logApiRequest(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'API request to test-model.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_API_REQUEST,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          model: 'test-model',
          request_text: 'This is a test request',
          prompt_id: 'prompt-id-7',
        },
      });
    });

    it('should log an API request without request_text', () => {
      const event = new ApiRequestEvent('test-model', 'prompt-id-6');

      logApiRequest(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'API request to test-model.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_API_REQUEST,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          model: 'test-model',
          prompt_id: 'prompt-id-6',
        },
      });
    });
  });

  describe('logFlashFallback', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    it('should log flash fallback event', () => {
      const event = new FlashFallbackEvent(AuthType.USE_VERTEX_AI);

      logFlashFallback(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Switching to flash as Fallback.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_FLASH_FALLBACK,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          auth_type: 'vertex-ai',
        },
      });
    });
  });

  describe('logRipgrepFallback', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logRipgrepFallbackEvent');
    });

    it('should log ripgrep fallback event', () => {
      const event = new RipgrepFallbackEvent(
        false,
        false,
        'ripgrep is not available',
      );

      logRipgrepFallback(mockConfig, event);

      expect(QwenLogger.prototype.logRipgrepFallbackEvent).toHaveBeenCalled();

      const emittedEvent = mockLogger.emit.mock.calls[0][0];
      expect(emittedEvent.body).toBe('Switching to grep as fallback.');
      expect(emittedEvent.attributes).toEqual(
        expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_RIPGREP_FALLBACK,
          error: 'ripgrep is not available',
        }),
      );
    });

    it('should log ripgrep fallback event with an error', () => {
      const event = new RipgrepFallbackEvent(false, false, 'rg not found');

      logRipgrepFallback(mockConfig, event);

      expect(QwenLogger.prototype.logRipgrepFallbackEvent).toHaveBeenCalled();

      const emittedEvent = mockLogger.emit.mock.calls[0][0];
      expect(emittedEvent.body).toBe('Switching to grep as fallback.');
      expect(emittedEvent.attributes).toEqual(
        expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_RIPGREP_FALLBACK,
          error: 'rg not found',
        }),
      );
    });
  });

  describe('logRipgrepRuntimeRecovery', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logRipgrepRuntimeRecoveryEvent');
    });

    it('logs privacy-safe runtime recovery fields', () => {
      const event = new RipgrepRuntimeRecoveryEvent({
        selection_mode: 'builtin',
        retry_triggered: true,
        retry_succeeded: true,
        failure_kind: 'eagain',
      });

      logRipgrepRuntimeRecovery(mockConfig, event);

      expect(
        QwenLogger.prototype.logRipgrepRuntimeRecoveryEvent,
      ).toHaveBeenCalledWith(event);
      const emittedEvent = mockLogger.emit.mock.calls[0][0];
      expect(emittedEvent.body).toBe('Ripgrep runtime recovery: eagain.');
      expect(emittedEvent.attributes).toEqual(
        expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_RIPGREP_RUNTIME_RECOVERY,
          selection_mode: 'builtin',
          retry_triggered: true,
          retry_succeeded: true,
          failure_kind: 'eagain',
        }),
      );
      expect(JSON.stringify(emittedEvent.attributes)).not.toMatch(
        /pattern|path|stdout|stderr|needle|repo/,
      );
    });
  });

  describe('logSkillLaunch', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logSkillLaunchEvent');
    });

    it('forwards the event to QwenLogger and emits an OTLP record', () => {
      const event = new SkillLaunchEvent('test-skill', true, 'prompt-id-42');

      logSkillLaunch(mockConfig, event);

      expect(QwenLogger.prototype.logSkillLaunchEvent).toHaveBeenCalledWith(
        event,
      );

      const emittedEvent = mockLogger.emit.mock.calls[0][0];
      expect(emittedEvent.body).toBe(
        'Skill launch: test-skill. Success: true.',
      );
      expect(emittedEvent.attributes).toEqual(
        expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_SKILL_LAUNCH,
          skill_name: 'test-skill',
          success: true,
          prompt_id: 'prompt-id-42',
        }),
      );
    });

    it('forwards to QwenLogger even when OTLP SDK is not initialized', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      const event = new SkillLaunchEvent('another-skill', false, 'prompt-id-7');

      logSkillLaunch(mockConfig, event);

      expect(QwenLogger.prototype.logSkillLaunchEvent).toHaveBeenCalledWith(
        event,
      );
      expect(mockLogger.emit).not.toHaveBeenCalled();
    });
  });

  describe('logToolCall', () => {
    const cfg1 = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getGeminiClient: () => mockGeminiClient,
    } as Config;
    const cfg2 = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getProjectRoot: () => '/test/project/root',
      getProxy: () => 'http://test.proxy.com:8080',
      getContentGeneratorConfig: () =>
        ({ model: 'test-model' }) as ContentGeneratorConfig,
      getModel: () => 'test-model',
      getEmbeddingModel: () => 'test-embedding-model',
      getWorkingDir: () => 'test-working-dir',
      getSandbox: () => true,
      getCoreTools: () => ['ls', 'read-file'],
      getApprovalMode: () => 'default',
      getTelemetryLogPromptsEnabled: () => true,
      getFileFilteringRespectGitIgnore: () => true,
      getFileFilteringAllowBuildArtifacts: () => false,
      getDebugMode: () => true,
      getMcpServers: () => ({
        'test-server': {
          command: 'test-command',
        },
      }),
      getQuestion: () => 'test-question',
      getToolRegistry: () => new ToolRegistry(cfg1),
      getFullContext: () => false,
      getUserMemory: () => 'user-memory',
    } as unknown as Config;

    const mockGeminiClient = new GeminiClient(cfg2);
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getGeminiClient: () => mockGeminiClient,
      getUsageStatisticsEnabled: () => true,
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
      getChatRecordingService: () => undefined,
    } as unknown as Config;

    const mockMetrics = {
      recordToolCallMetrics: vi.fn(),
      recordToolExecutionMetrics: vi.fn(),
    };

    beforeEach(() => {
      vi.spyOn(metrics, 'recordToolCallMetrics').mockImplementation(
        mockMetrics.recordToolCallMetrics,
      );
      vi.spyOn(metrics, 'recordToolExecutionMetrics').mockImplementation(
        mockMetrics.recordToolExecutionMetrics,
      );
      vi.spyOn(QwenLogger.prototype, 'logToolCallEvent').mockImplementation(
        () => undefined,
      );
      mockLogger.emit.mockReset();
    });

    it('normalizes an unclassified error before every consumer', () => {
      const recordUiTelemetryEvent = vi.fn();
      const configWithRecording = {
        ...mockConfig,
        getChatRecordingService: () => ({ recordUiTelemetryEvent }),
      } as unknown as Config;
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        function_name: '   ',
        function_args: { value: 1 },
        duration_ms: 25,
        status: 'error',
        success: true,
        error: 'failed',
        error_type: ' ',
        prompt_id: 'prompt-normalize',
        tool_type: 'native',
      } as ToolCallEvent;

      logToolCall(configWithRecording, event);

      const normalized = expect.objectContaining({
        function_name: 'unknown_tool',
        status: 'error',
        success: false,
        execution_status: 'unknown',
        error: 'failed',
        error_type: ToolErrorType.UNKNOWN,
      });
      expect(QwenLogger.prototype.logToolCallEvent).toHaveBeenCalledWith(
        normalized,
      );
      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        normalized,
        'test-session-id',
      );
      expect(recordUiTelemetryEvent).toHaveBeenCalledWith(normalized);
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({
            function_name: 'unknown_tool',
            status: 'error',
            success: false,
            execution_status: 'unknown',
            error: 'failed',
            error_type: ToolErrorType.UNKNOWN,
            'error.message': 'failed',
            'error.type': ToolErrorType.UNKNOWN,
          }),
        }),
      );
      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        configWithRecording,
        25,
        {
          function_name: 'unknown_tool',
          status: 'error',
          success: false,
          decision: undefined,
          tool_type: 'native',
        },
      );
      expect(mockMetrics.recordToolExecutionMetrics).toHaveBeenCalledWith(
        configWithRecording,
        {
          execution_status: 'unknown',
          tool_type: 'native',
        },
      );
      expect(event).not.toHaveProperty('execution_status');
      expect(event.function_name).toBe('   ');
      expect(event.success).toBe(true);
      expect(event.error_type).toBe(' ');
    });

    it('clears call errors when cancellation is the final outcome', () => {
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        function_name: 'shell',
        function_args: {},
        duration_ms: 1,
        status: 'cancelled',
        execution_status: 'cancelled',
        success: true,
        error: 'cancelled by user',
        error_type: ToolErrorType.UNHANDLED_EXCEPTION,
        prompt_id: 'prompt-id',
        tool_type: 'native',
      } as ToolCallEvent;

      const normalized = normalizeToolCallEvent(event);

      expect(normalized.success).toBe(false);
      expect(normalized).not.toHaveProperty('error');
      expect(normalized).not.toHaveProperty('error_type');
      expect(event.error).toBe('cancelled by user');
    });

    it('preserves a nonblank function name byte-for-byte', () => {
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        function_name: '  padded_tool  ',
        function_args: {},
        duration_ms: 1,
        status: 'success',
        success: true,
        prompt_id: 'prompt-padded',
        tool_type: 'native',
      } as ToolCallEvent;

      expect(normalizeToolCallEvent(event).function_name).toBe(
        '  padded_tool  ',
      );
    });

    it('preserves an explicitly classified error type', () => {
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        function_name: 'test-function',
        function_args: {},
        duration_ms: 10,
        status: 'error',
        success: false,
        error: 'classified failure',
        error_type: ToolErrorType.EXECUTION_FAILED,
        prompt_id: 'prompt-classified',
        tool_type: 'native',
      } as ToolCallEvent;

      logToolCall(mockConfig, event);

      expect(QwenLogger.prototype.logToolCallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          error_type: ToolErrorType.EXECUTION_FAILED,
          execution_status: 'unknown',
        }),
      );
      expect(mockLogger.emit.mock.calls[0][0].attributes).toMatchObject({
        error_type: ToolErrorType.EXECUTION_FAILED,
        'error.type': ToolErrorType.EXECUTION_FAILED,
      });
    });

    it('normalizes a missing execution_status to unknown end-to-end', () => {
      const configWithRecording = {
        ...mockConfig,
        getChatRecordingService: () => ({ recordUiTelemetryEvent: vi.fn() }),
      } as unknown as Config;
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        function_name: 'legacy_tool',
        function_args: {},
        duration_ms: 42,
        status: 'success',
        success: true,
        prompt_id: 'prompt-legacy',
        tool_type: 'native',
      } as ToolCallEvent;

      expect(event).not.toHaveProperty('execution_status');

      logToolCall(configWithRecording, event);

      expect(mockMetrics.recordToolExecutionMetrics).toHaveBeenCalledWith(
        configWithRecording,
        {
          execution_status: 'unknown',
          tool_type: 'native',
        },
      );
      expect(QwenLogger.prototype.logToolCallEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          execution_status: 'unknown',
        }),
      );
    });

    it.each([
      { status: 'success' as const, expectedSuccess: true },
      { status: 'cancelled' as const, expectedSuccess: false },
    ])(
      'clears stale error fields for $status events',
      ({ status, expectedSuccess }) => {
        const event = {
          'event.name': 'tool_call',
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          function_name: 'test-function',
          function_args: {},
          duration_ms: 10,
          status,
          success: !expectedSuccess,
          error: 'stale error',
          error_type: ToolErrorType.EXECUTION_FAILED,
          prompt_id: 'prompt-terminal',
          tool_type: 'native',
        } as ToolCallEvent;

        logToolCall(mockConfig, event);

        const normalizedEvent = vi.mocked(QwenLogger.prototype.logToolCallEvent)
          .mock.calls[0][0];
        expect(normalizedEvent).toMatchObject({
          status,
          success: expectedSuccess,
          execution_status: 'unknown',
        });
        expect(normalizedEvent).not.toHaveProperty('error');
        expect(normalizedEvent).not.toHaveProperty('error_type');
        const attributes = mockLogger.emit.mock.calls[0][0].attributes;
        expect(attributes).not.toHaveProperty('error.message');
        expect(attributes).not.toHaveProperty('error.type');
        expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
          mockConfig,
          10,
          expect.objectContaining({ status, success: expectedSuccess }),
        );
      },
    );

    it('normalizes non-OTel consumers when the SDK is disabled', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        function_name: '',
        function_args: {},
        duration_ms: 10,
        status: 'error',
        success: true,
        prompt_id: 'prompt-no-otel',
        tool_type: 'native',
      } as ToolCallEvent;

      logToolCall(mockConfig, event);

      const normalized = expect.objectContaining({
        function_name: 'unknown_tool',
        status: 'error',
        success: false,
        execution_status: 'unknown',
        error_type: ToolErrorType.UNKNOWN,
      });
      expect(QwenLogger.prototype.logToolCallEvent).toHaveBeenCalledWith(
        normalized,
      );
      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        normalized,
        'test-session-id',
      );
      expect(mockLogger.emit).not.toHaveBeenCalled();
      expect(mockMetrics.recordToolCallMetrics).not.toHaveBeenCalled();
      expect(mockMetrics.recordToolExecutionMetrics).not.toHaveBeenCalled();
    });

    it('isolates every tool-call telemetry sink failure', () => {
      const chatSink = vi.fn(() => {
        throw new Error('chat sink failed');
      });
      const qwenSink = vi.fn(() => {
        throw new Error('qwen sink failed');
      });
      const qwenLoggerSpy = vi
        .spyOn(QwenLogger, 'getInstance')
        .mockReturnValue({
          logToolCallEvent: qwenSink,
        } as unknown as QwenLogger);
      mockUiEvent.addEvent.mockImplementationOnce(() => {
        throw new Error('ui sink failed');
      });
      mockLogger.emit.mockImplementationOnce(() => {
        throw new Error('otel sink failed');
      });
      mockMetrics.recordToolCallMetrics.mockImplementationOnce(() => {
        throw new Error('legacy metric sink failed');
      });
      mockMetrics.recordToolExecutionMetrics.mockImplementationOnce(() => {
        throw new Error('execution metric sink failed');
      });
      const config = {
        ...mockConfig,
        getChatRecordingService: () => ({
          recordUiTelemetryEvent: chatSink,
        }),
      } as unknown as Config;
      const event = {
        'event.name': 'tool_call',
        'event.timestamp': '2025-01-01T00:00:00.000Z',
        call_id: 'call-id',
        function_name: 'read_file',
        function_args: {},
        duration_ms: 1,
        status: 'success',
        execution_status: 'success',
        success: true,
        prompt_id: 'prompt-id',
        tool_type: 'native',
      } as ToolCallEvent;

      expect(() => logToolCall(config, event)).not.toThrow();
      expect(mockUiEvent.addEvent).toHaveBeenCalled();
      expect(chatSink).toHaveBeenCalled();
      expect(qwenSink).toHaveBeenCalled();
      expect(mockLogger.emit).toHaveBeenCalled();
      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalled();
      expect(mockMetrics.recordToolExecutionMetrics).toHaveBeenCalledWith(
        config,
        {
          execution_status: 'success',
          tool_type: 'native',
        },
      );
      qwenLoggerSpy.mockRestore();
    });

    it('should log a tool call with all fields', () => {
      const tool = new EditTool(mockConfig);
      const call: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'test-function',
          args: {
            arg1: 'value1',
            arg2: 2,
          },
          callId: 'test-call-id',
          isClientInitiated: true,
          prompt_id: 'prompt-id-1',
        },
        response: {
          callId: 'test-call-id',
          responseParts: [{ text: 'test-response' }],
          resultDisplay: {
            fileDiff: 'diff',
            fileName: 'file.txt',
            originalContent: 'old content',
            newContent: 'new content',
            diffStat: {
              model_added_lines: 1,
              model_removed_lines: 2,
              model_added_chars: 3,
              model_removed_chars: 4,
              user_added_lines: 5,
              user_removed_lines: 6,
              user_added_chars: 7,
              user_removed_chars: 8,
            },
          },
          error: undefined,
          errorType: undefined,
          contentLength: 13,
          executionStatus: 'success',
        },
        tool,
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
        outcome: ToolConfirmationOutcome.ProceedOnce,
      };
      const event = new ToolCallEvent(call);

      logToolCall(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool call: test-function. Decision: accept. Success: true. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          call_id: 'test-call-id',
          function_name: 'test-function',
          function_args: JSON.stringify(
            {
              arg1: 'value1',
              arg2: 2,
            },
            null,
            2,
          ),
          duration_ms: 100,
          status: 'success',
          execution_status: 'success',
          success: true,
          decision: ToolCallDecision.ACCEPT,
          prompt_id: 'prompt-id-1',
          tool_type: 'native',
          metadata: {
            model_added_lines: 1,
            model_removed_lines: 2,
            model_added_chars: 3,
            model_removed_chars: 4,
            user_added_lines: 5,
            user_removed_lines: 6,
            user_added_chars: 7,
            user_removed_chars: 8,
          },
          content_length: 13,
          mcp_server_name: undefined,
          response_id: undefined,
        },
      });

      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        {
          function_name: 'test-function',
          status: 'success',
          success: true,
          decision: ToolCallDecision.ACCEPT,
          tool_type: 'native',
        },
      );
      expect(mockMetrics.recordToolExecutionMetrics).toHaveBeenCalledWith(
        mockConfig,
        {
          execution_status: 'success',
          tool_type: 'native',
        },
      );

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...normalizeToolCallEvent(event),
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
        },
        'test-session-id',
      );
    });
    it('should log a tool call with a reject decision', () => {
      const call: ErroredToolCall = {
        status: 'error',
        request: {
          name: 'test-function',
          args: {
            arg1: 'value1',
            arg2: 2,
          },
          callId: 'test-call-id',
          isClientInitiated: true,
          prompt_id: 'prompt-id-2',
        },
        response: {
          callId: 'test-call-id',
          responseParts: [{ text: 'test-response' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
          contentLength: undefined,
          executionStatus: 'not_started',
        },
        durationMs: 100,
        outcome: ToolConfirmationOutcome.Cancel,
      };
      const event = new ToolCallEvent(call);

      logToolCall(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool call: test-function. Decision: reject. Success: false. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          call_id: 'test-call-id',
          function_name: 'test-function',
          function_args: JSON.stringify(
            {
              arg1: 'value1',
              arg2: 2,
            },
            null,
            2,
          ),
          duration_ms: 100,
          status: 'error',
          execution_status: 'not_started',
          success: false,
          decision: ToolCallDecision.REJECT,
          prompt_id: 'prompt-id-2',
          tool_type: 'native',
          error: undefined,
          error_type: ToolErrorType.UNKNOWN,
          'error.type': ToolErrorType.UNKNOWN,
          metadata: undefined,
          content_length: undefined,
          mcp_server_name: undefined,
          response_id: undefined,
        },
      });

      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        {
          function_name: 'test-function',
          status: 'error',
          success: false,
          decision: ToolCallDecision.REJECT,
          tool_type: 'native',
        },
      );

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...normalizeToolCallEvent(event),
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
        },
        'test-session-id',
      );
    });

    it('should log a tool call with a modify decision', () => {
      const call: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'test-function',
          args: {
            arg1: 'value1',
            arg2: 2,
          },
          callId: 'test-call-id',
          isClientInitiated: true,
          prompt_id: 'prompt-id-3',
        },
        response: {
          callId: 'test-call-id',
          responseParts: [{ text: 'test-response' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
          contentLength: 13,
          executionStatus: 'success',
        },
        outcome: ToolConfirmationOutcome.ModifyWithEditor,
        tool: new EditTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
      };
      const event = new ToolCallEvent(call);

      logToolCall(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool call: test-function. Decision: modify. Success: true. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          call_id: 'test-call-id',
          function_name: 'test-function',
          function_args: JSON.stringify(
            {
              arg1: 'value1',
              arg2: 2,
            },
            null,
            2,
          ),
          duration_ms: 100,
          status: 'success',
          execution_status: 'success',
          success: true,
          decision: ToolCallDecision.MODIFY,
          prompt_id: 'prompt-id-3',
          tool_type: 'native',
          metadata: undefined,
          content_length: 13,
          mcp_server_name: undefined,
          response_id: undefined,
        },
      });

      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        {
          function_name: 'test-function',
          status: 'success',
          success: true,
          decision: ToolCallDecision.MODIFY,
          tool_type: 'native',
        },
      );

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...normalizeToolCallEvent(event),
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
        },
        'test-session-id',
      );
    });

    it('should log a tool call without a decision', () => {
      const call: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'test-function',
          args: {
            arg1: 'value1',
            arg2: 2,
          },
          callId: 'test-call-id',
          isClientInitiated: true,
          prompt_id: 'prompt-id-4',
        },
        response: {
          callId: 'test-call-id',
          responseParts: [{ text: 'test-response' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
          contentLength: 13,
          executionStatus: 'success',
        },
        tool: new EditTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
      };
      const event = new ToolCallEvent(call);

      logToolCall(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool call: test-function. Success: true. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          call_id: 'test-call-id',
          function_name: 'test-function',
          function_args: JSON.stringify(
            {
              arg1: 'value1',
              arg2: 2,
            },
            null,
            2,
          ),
          duration_ms: 100,
          status: 'success',
          execution_status: 'success',
          success: true,
          prompt_id: 'prompt-id-4',
          tool_type: 'native',
          decision: undefined,
          metadata: undefined,
          content_length: 13,
          mcp_server_name: undefined,
          response_id: undefined,
        },
      });

      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        {
          function_name: 'test-function',
          status: 'success',
          success: true,
          decision: undefined,
          tool_type: 'native',
        },
      );

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...normalizeToolCallEvent(event),
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
        },
        'test-session-id',
      );
    });

    it('should log a failed tool call with an error', () => {
      const errorMessage = 'test-error';
      const call: ErroredToolCall = {
        status: 'error',
        request: {
          name: 'test-function',
          args: {
            arg1: 'value1',
            arg2: 2,
          },
          callId: 'test-call-id',
          isClientInitiated: true,
          prompt_id: 'prompt-id-5',
        },
        response: {
          callId: 'test-call-id',
          responseParts: [{ text: 'test-response' }],
          resultDisplay: undefined,
          error: new Error(errorMessage),
          errorType: ToolErrorType.UNKNOWN,
          contentLength: errorMessage.length,
          executionStatus: 'error',
        },
        durationMs: 100,
      };
      const event = new ToolCallEvent(call);

      logToolCall(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool call: test-function. Success: false. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          call_id: 'test-call-id',
          function_name: 'test-function',
          function_args: JSON.stringify(
            {
              arg1: 'value1',
              arg2: 2,
            },
            null,
            2,
          ),
          duration_ms: 100,
          status: 'error',
          execution_status: 'error',
          success: false,
          error: 'test-error',
          'error.message': 'test-error',
          error_type: ToolErrorType.UNKNOWN,
          'error.type': ToolErrorType.UNKNOWN,
          prompt_id: 'prompt-id-5',
          tool_type: 'native',
          decision: undefined,
          metadata: undefined,
          content_length: errorMessage.length,
          mcp_server_name: undefined,
          response_id: undefined,
        },
      });

      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        {
          function_name: 'test-function',
          status: 'error',
          success: false,
          decision: undefined,
          tool_type: 'native',
        },
      );

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...normalizeToolCallEvent(event),
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
        },
        'test-session-id',
      );
    });

    it('should log a tool call with mcp_server_name for MCP tools', () => {
      const mockMcpTool = new DiscoveredMCPTool(
        {} as CallableTool,
        'mock_mcp_server',
        'mock_mcp_tool',
        'tool description',
        {
          type: 'object',
          properties: {
            arg1: { type: 'string' },
            arg2: { type: 'number' },
          },
          required: ['arg1', 'arg2'],
        },
      );

      const call: CompletedToolCall = {
        status: 'success',
        request: {
          name: 'mock_mcp_tool',
          args: { arg1: 'value1', arg2: 2 },
          callId: 'test-call-id',
          isClientInitiated: true,
          prompt_id: 'prompt-id',
        },
        response: {
          callId: 'test-call-id',
          responseParts: [{ text: 'test-response' }],
          resultDisplay: undefined,
          error: undefined,
          errorType: undefined,
          executionStatus: 'success',
        },
        tool: mockMcpTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
      };
      const event = new ToolCallEvent(call);

      logToolCall(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool call: mock_mcp_tool. Success: true. Duration: 100ms.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          call_id: 'test-call-id',
          function_name: 'mock_mcp_tool',
          function_args: JSON.stringify(
            {
              arg1: 'value1',
              arg2: 2,
            },
            null,
            2,
          ),
          duration_ms: 100,
          status: 'success',
          execution_status: 'success',
          success: true,
          prompt_id: 'prompt-id',
          tool_type: 'mcp',
          mcp_server_name: 'mock_mcp_server',
          decision: undefined,
          metadata: undefined,
          content_length: undefined,
          response_id: undefined,
        },
      });
    });

    it.each(['prompt_suggestion', 'forked_query', 'speculation'])(
      'should not record to chatRecordingService when prompt_id is %s',
      (promptId) => {
        const mockRecordUiTelemetryEvent = vi.fn();
        const configWithRecording = {
          ...mockConfig,
          getChatRecordingService: () => ({
            recordUiTelemetryEvent: mockRecordUiTelemetryEvent,
          }),
        } as unknown as Config;

        const call: CompletedToolCall = {
          status: 'success',
          request: {
            name: 'test-function',
            args: {},
            callId: 'test-call-id',
            isClientInitiated: true,
            prompt_id: promptId,
          },
          response: {
            callId: 'test-call-id',
            responseParts: [{ text: 'ok' }],
            resultDisplay: undefined,
            error: undefined,
            errorType: undefined,
            executionStatus: 'success',
          },
          tool: new EditTool(mockConfig),
          invocation: {} as AnyToolInvocation,
          durationMs: 50,
          outcome: ToolConfirmationOutcome.ProceedOnce,
        };
        const event = new ToolCallEvent(call);
        logToolCall(configWithRecording, event);

        expect(mockRecordUiTelemetryEvent).not.toHaveBeenCalled();
        expect(mockUiEvent.addEvent).toHaveBeenCalled();
      },
    );
  });

  describe('logMalformedJsonResponse', () => {
    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logMalformedJsonResponseEvent');
    });

    it('logs the event to Clearcut and OTEL', () => {
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = new MalformedJsonResponseEvent('test-model');

      logMalformedJsonResponse(mockConfig, event);

      expect(
        QwenLogger.prototype.logMalformedJsonResponseEvent,
      ).toHaveBeenCalledWith(event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Malformed JSON response from test-model.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_MALFORMED_JSON_RESPONSE,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          model: 'test-model',
        },
      });
    });
  });

  describe('logFileOperation', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getUsageStatisticsEnabled: () => true,
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
    } as Config;

    const mockMetrics = {
      recordFileOperationMetric: vi.fn(),
    };

    beforeEach(() => {
      vi.spyOn(metrics, 'recordFileOperationMetric').mockImplementation(
        mockMetrics.recordFileOperationMetric,
      );
    });

    it('should log a file operation event', () => {
      const event = new FileOperationEvent(
        'test-tool',
        FileOperation.READ,
        10,
        'text/plain',
        '.txt',
        'typescript',
      );

      logFileOperation(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'File operation: read. Lines: 10.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_FILE_OPERATION,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          tool_name: 'test-tool',
          operation: 'read',
          lines: 10,
          mimetype: 'text/plain',
          extension: '.txt',
          programming_language: 'typescript',
        },
      });

      expect(mockMetrics.recordFileOperationMetric).toHaveBeenCalledWith(
        mockConfig,
        {
          operation: 'read',
          lines: 10,
          mimetype: 'text/plain',
          extension: '.txt',
          programming_language: 'typescript',
        },
      );
    });
  });

  describe('logToolOutputTruncated', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    it('should log a tool output truncated event', () => {
      const event = new ToolOutputTruncatedEvent('prompt-id-1', {
        toolName: 'test-tool',
        originalContentLength: 1000,
        truncatedContentLength: 100,
        threshold: 500,
        lines: 10,
      });

      logToolOutputTruncated(mockConfig, event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Tool output truncated for test-tool.',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_TOOL_OUTPUT_TRUNCATED,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          eventName: 'tool_output_truncated',
          prompt_id: 'prompt-id-1',
          tool_name: 'test-tool',
          original_content_length: 1000,
          truncated_content_length: 100,
          threshold: 500,
          lines: 10,
        },
      });
    });
  });

  describe('logExtensionInstall', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logExtensionInstallEvent');
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should log extension install event', () => {
      const event = new ExtensionInstallEvent(
        'vscode',
        '0.1.0',
        'git',
        'success',
      );

      logExtensionInstallEvent(mockConfig, event);

      expect(
        QwenLogger.prototype.logExtensionInstallEvent,
      ).toHaveBeenCalledWith(event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Installed extension vscode',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_EXTENSION_INSTALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          extension_name: 'vscode',
          extension_version: '0.1.0',
          extension_source: 'git',
          status: 'success',
        },
      });
    });
  });

  describe('logExtensionUninstall', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logExtensionUninstallEvent');
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should log extension uninstall event', () => {
      const event = new ExtensionUninstallEvent('vscode', 'success');

      logExtensionUninstall(mockConfig, event);

      expect(
        QwenLogger.prototype.logExtensionUninstallEvent,
      ).toHaveBeenCalledWith(event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Uninstalled extension vscode',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_EXTENSION_UNINSTALL,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          extension_name: 'vscode',
          status: 'success',
        },
      });
    });
  });

  describe('logExtensionEnable', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logExtensionEnableEvent');
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should log extension enable event', () => {
      const event = new ExtensionEnableEvent('vscode', 'user');

      logExtensionEnable(mockConfig, event);

      expect(QwenLogger.prototype.logExtensionEnableEvent).toHaveBeenCalledWith(
        event,
      );

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Enabled extension vscode',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_EXTENSION_ENABLE,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          extension_name: 'vscode',
          setting_scope: 'user',
        },
      });
    });
  });

  describe('logExtensionDisable', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
    } as unknown as Config;

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logExtensionDisableEvent');
    });

    afterEach(() => {
      vi.resetAllMocks();
    });

    it('should log extension disable event', () => {
      const event = new ExtensionDisableEvent('vscode', 'user');

      logExtensionDisable(mockConfig, event);

      expect(
        QwenLogger.prototype.logExtensionDisableEvent,
      ).toHaveBeenCalledWith(event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Disabled extension vscode',
        attributes: {
          'session.id': 'test-session-id',
          'event.name': EVENT_EXTENSION_DISABLE,
          'event.timestamp': '2025-01-01T00:00:00.000Z',
          extension_name: 'vscode',
          setting_scope: 'user',
        },
      });
    });
  });

  describe('logHookCall', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTargetDir: () => 'target-dir',
      getUsageStatisticsEnabled: () => true,
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
    } as unknown as Config;

    const mockQwenLogger = {
      logHookCallEvent: vi.fn(),
    };

    beforeEach(() => {
      vi.spyOn(QwenLogger, 'getInstance').mockReturnValue(
        mockQwenLogger as unknown as QwenLogger,
      );
      mockQwenLogger.logHookCallEvent.mockClear();
    });

    it('should log a successful hook call to QwenLogger', () => {
      const event = new HookCallEvent(
        'UserPromptSubmit',
        'command',
        'check-secrets.sh',
        { prompt: 'test prompt' },
        150,
        true,
        { output: 'success' },
        0,
        'stdout message',
        'stderr message',
        undefined,
      );

      logHookCall(mockConfig, event);

      // Should call QwenLogger
      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should log a failed hook call with error', () => {
      const event = new HookCallEvent(
        'Stop',
        'command',
        'cleanup.sh',
        { last_assistant_message: 'final message' },
        200,
        false,
        undefined,
        1,
        'stdout message',
        'stderr message',
        'Error occurred',
      );

      logHookCall(mockConfig, event);

      // Should call QwenLogger
      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should handle when QwenLogger is not available', () => {
      vi.spyOn(QwenLogger, 'getInstance').mockReturnValue(undefined);

      const event = new HookCallEvent(
        'UserPromptSubmit',
        'command',
        'test-hook.sh',
        { prompt: 'test' },
        100,
        true,
      );

      // Should not throw when QwenLogger is not available
      expect(() => logHookCall(mockConfig, event)).not.toThrow();
    });

    it('should log hook call with all optional fields', () => {
      const event = new HookCallEvent(
        'PreToolUse',
        'command',
        'validator.sh',
        { tool_name: 'read_file', path: '/test/file.txt' },
        250,
        true,
        { decision: 'allow', reason: 'validated' },
        0,
        'validation passed',
        '',
        undefined,
      );

      logHookCall(mockConfig, event);

      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should log hook call with minimal fields', () => {
      const event = new HookCallEvent(
        'SessionStart',
        'command',
        'init.sh',
        {},
        10,
        true,
      );

      logHookCall(mockConfig, event);

      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should log hook call with exit code', () => {
      const event = new HookCallEvent(
        'PostToolUseFailure',
        'command',
        'error-handler.sh',
        { tool_name: 'shell' },
        50,
        false,
        undefined,
        1,
        '',
        'error output',
        'Command failed with exit code 1',
      );

      logHookCall(mockConfig, event);

      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should log hook call with zero exit code on success', () => {
      const event = new HookCallEvent(
        'PostToolUse',
        'command',
        'success-handler.sh',
        { tool_name: 'write_file' },
        100,
        true,
        { result: 'ok' },
        0,
        'done',
        '',
        undefined,
      );

      logHookCall(mockConfig, event);

      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should log hook call with non-zero exit code on failure', () => {
      const event = new HookCallEvent(
        'PostToolUseFailure',
        'command',
        'failure-handler.sh',
        { tool_name: 'shell' },
        75,
        false,
        undefined,
        127,
        '',
        'command not found',
        'Hook command not found',
      );

      logHookCall(mockConfig, event);

      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    });

    it('should log all hook event types', () => {
      const eventTypes = [
        'PreToolUse',
        'PostToolUse',
        'PostToolUseFailure',
        'Notification',
        'UserPromptSubmit',
        'SessionStart',
        'SessionEnd',
        'Stop',
        'SubagentStart',
        'SubagentStop',
        'PreCompact',
        'PermissionRequest',
      ];

      for (const eventType of eventTypes) {
        mockQwenLogger.logHookCallEvent.mockClear();

        const event = new HookCallEvent(
          eventType,
          'command',
          'test-hook.sh',
          {},
          100,
          true,
        );

        logHookCall(mockConfig, event);

        expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
      }
    });

    it('should pass the exact event object to QwenLogger', () => {
      const event = new HookCallEvent(
        'PreToolUse',
        'command',
        'test-hook.sh',
        { tool_name: 'read_file' },
        100,
        true,
      );

      logHookCall(mockConfig, event);

      // Verify the exact event object is passed
      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledTimes(1);
      const passedEvent = mockQwenLogger.logHookCallEvent.mock.calls[0][0];
      expect(passedEvent).toBe(event);
    });
  });

  // Phase 4b — logApiRetry: HTTP-status retry telemetry from retryWithBackoff.
  describe('logApiRetry (Phase 4b)', () => {
    const mockQwenLogger = {
      logApiRetryEvent: vi.fn(),
    };

    beforeEach(() => {
      vi.spyOn(QwenLogger, 'getInstance').mockReturnValue(
        mockQwenLogger as unknown as QwenLogger,
      );
      mockQwenLogger.logApiRetryEvent.mockClear();
      vi.spyOn(metrics, 'recordApiRetry');
    });

    function buildEvent(
      overrides: Partial<{
        model: string;
        promptId: string;
        attemptNumber: number;
        status: number;
        delay: number;
        errorMsg: string;
        subagentName: string;
      }> = {},
    ): ApiRetryEvent {
      const err = new Error(overrides.errorMsg ?? 'rate limited');
      return new ApiRetryEvent({
        model: overrides.model ?? 'qwen3',
        promptId: overrides.promptId ?? 'p-1',
        attemptNumber: overrides.attemptNumber ?? 2,
        error: err,
        statusCode: overrides.status ?? 429,
        retryDelayMs: overrides.delay ?? 1500,
        subagentName: overrides.subagentName,
      });
    }

    it('fans out to all 3 sinks: QwenLogger, OTel log, and metric counter', () => {
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = buildEvent();
      logApiRetry(mockConfig, event);

      // 1. QwenLogger RUM
      expect(mockQwenLogger.logApiRetryEvent).toHaveBeenCalledWith(event);
      // 2. OTel log signal — picked up by LogToSpanProcessor to bridge as span
      expect(mockLogger.emit).toHaveBeenCalledTimes(1);
      const logRecord = mockLogger.emit.mock.calls[0][0];
      expect(logRecord.body).toContain('API retry attempt 2');
      expect(logRecord.body).toContain('qwen3');
      expect(logRecord.body).toContain('status 429');
      expect(logRecord.attributes['event.name']).toBe('qwen-code.api_retry');
      expect(logRecord.attributes['attempt_number']).toBe(2);
      expect(logRecord.attributes['retry_delay_ms']).toBe(1500);
      expect(logRecord.attributes['status_code']).toBe(429);
      expect(logRecord.attributes['model']).toBe('qwen3');
      // 3. Metric counter — tagged with {model}
      expect(metrics.recordApiRetry).toHaveBeenCalledWith(mockConfig, {
        model: 'qwen3',
      });
    });

    it('propagates subagent_name when present', () => {
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = buildEvent({ subagentName: 'explore-agent' });
      logApiRetry(mockConfig, event);

      const logRecord = mockLogger.emit.mock.calls[0][0];
      expect(logRecord.attributes['subagent_name']).toBe('explore-agent');
    });

    it('skips logger.emit and metric counter when SDK is not initialized (QwenLogger still called)', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = buildEvent();
      logApiRetry(mockConfig, event);

      expect(mockQwenLogger.logApiRetryEvent).toHaveBeenCalledWith(event);
      expect(mockLogger.emit).not.toHaveBeenCalled();
      expect(metrics.recordApiRetry).not.toHaveBeenCalled();
    });

    it('increments the api-activity retry counter for the daemon health chart', () => {
      apiActivityTracker.drain(); // isolate from other cases (global singleton)
      const mockConfig = makeFakeConfig({ sessionId: 'test-session-id' });
      logApiRetry(mockConfig, buildEvent());
      expect(apiActivityTracker.peek()).toEqual({ errors: 0, retries: 1 });
    });

    it('counts the retry even when the OTel SDK is not initialized', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      apiActivityTracker.drain();
      logApiRetry(makeFakeConfig({ sessionId: 's' }), buildEvent());
      // The daemon health chart is independent of OTel export state.
      expect(apiActivityTracker.peek().retries).toBe(1);
    });
  });
});
