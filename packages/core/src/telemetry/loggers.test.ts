/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { logs } from '@opentelemetry/api-logs';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { Config } from '../config/config.js';
import type {
  AnyToolInvocation,
  CompletedToolCall,
  ContentGeneratorConfig,
} from '../index.js';
import {
  AuthType,
  LlmClient,
  ToolConfirmationOutcome,
  ToolErrorType,
  ToolRegistry,
} from '../index.js';
import type {
  ToolCallRequestInfo,
  ToolCallResponseInfo,
  ToolExecutionStatus,
} from '../core/turn.js';
import { EditTool } from '../tools/edit.js';
import { OutputFormat } from '../output/types.js';
import { RECALL_SKIP_SELECTOR_ON_UNIQUE_STRONG_HIT_ENV } from '../memory/recall-experiment.js';
import {
  EVENT_API_REQUEST,
  EVENT_API_RESPONSE,
  EVENT_CLI_CONFIG,
  EVENT_FLASH_FALLBACK,
  EVENT_GOAL_STATE,
  EVENT_TOOL_CALL,
  EVENT_REPEATED_TOOL_FAILURE_GUARD,
  EVENT_USER_PROMPT,
  EVENT_MALFORMED_JSON_RESPONSE,
  EVENT_FILE_OPERATION,
  EVENT_RIPGREP_FALLBACK,
  EVENT_RIPGREP_RUNTIME_RECOVERY,
  EVENT_SESSION_END,
  EVENT_SESSION_START,
  EVENT_SKILL_LAUNCH,
  EVENT_EXTENSION_ENABLE,
  EVENT_EXTENSION_DISABLE,
  EVENT_EXTENSION_INSTALL,
  EVENT_EXTENSION_UNINSTALL,
  EVENT_TOOL_OUTPUT_TRUNCATED,
  EVENT_PROTOCOL_TAG_SANITIZED,
  EVENT_MEMORY_RECALL_DELIVERY,
  EVENT_MEMORY_SEARCH,
  EVENT_MEMORY_MIGRATION,
  EVENT_MEMORY_RECALL_MODE_TRANSITION,
  EVENT_WORKFLOW_RUN,
} from './constants.js';
import {
  logApiRequest,
  logApiResponse,
  logStartSession,
  logSessionEnd,
  logUserPrompt,
  logToolCall,
  logLoopDetected,
  logRepeatedToolFailureGuard,
  logFlashFallback,
  logGoalState,
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
  logMemoryRecall,
  logMemoryRecallDelivery,
  logMemorySearch,
  logMemoryMigration,
  logMemoryRecallModeTransition,
  logWorkflowRun,
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
  makeGoalStateEvent,
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
  MemoryRecallEvent,
  MemorySearchEvent,
  MemoryMigrationEvent,
  MemoryRecallModeTransitionEvent,
  LoopDetectedEvent,
  LoopType,
  RepeatedToolFailureGuardEvent,
  WorkflowRunEvent,
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

const throwing = (message: string) => () => {
  throw new Error(message);
};

describe('loggers', () => {
  const mockLogger = {
    emit: vi.fn(),
    enabled: vi.fn().mockReturnValue(true),
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

  const TS = '2025-01-01T00:00:00.000Z';
  const expectEmitted = (
    body: string,
    eventName: string,
    attributes: Record<string, unknown>,
    sessionId = 'test-session-id',
  ) =>
    expect(mockLogger.emit).toHaveBeenCalledWith({
      body,
      attributes: {
        'session.id': sessionId,
        'event.name': eventName,
        'event.timestamp': TS,
        ...attributes,
      },
    });
  const expectRequestSessionId = () =>
    expect(mockLogger.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'session.id': 'request-session-id',
        }),
      }),
    );
  // A hand-rolled config exposing exactly these getters.
  const cfg = (getters: Record<string, () => unknown> = {}) =>
    ({
      getSessionId: () => 'test-session-id',
      getUsageStatisticsEnabled: () => true,
      ...getters,
    }) as unknown as Config;
  const TELEMETRY_GETTERS = {
    getTargetDir: () => 'target-dir',
    getTelemetryEnabled: () => true,
    getTelemetryLogPromptsEnabled: () => true,
  };
  // Usage statistics off; the chat recording service is the returned spy.
  const withRecording = (record = vi.fn()) => ({
    record,
    config: cfg({
      getUsageStatisticsEnabled: () => false,
      getChatRecordingService: () => ({ recordUiTelemetryEvent: record }),
    }),
  });
  const apiError = (promptId: string, errorMessage = 'test error') =>
    new ApiErrorEvent({
      model: 'test-model',
      durationMs: 100,
      promptId,
      errorMessage,
    });

  it('publishes the workflow outcome and resume counters', () => {
    const config = makeFakeConfig({ sessionId: 'test-session-id' });
    logWorkflowRun(
      config,
      new WorkflowRunEvent({
        status: 'completed',
        agents_dispatched: 5,
        agents_completed: 5,
        agents_failed: 2,
        agents_cached: 1,
        agents_respawned: 3,
        phase_count: 2,
        tokens_spent: 900,
        duration_ms: 1_200,
      }),
    );

    expect(mockLogger.emit).toHaveBeenCalledWith({
      body: 'Workflow run completed.',
      attributes: expect.objectContaining({
        'event.name': EVENT_WORKFLOW_RUN,
        agents_dispatched: 5,
        agents_completed: 5,
        agents_failed: 2,
        agents_cached: 1,
        agents_respawned: 3,
      }),
    });
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
      expectEmitted(
        'Suppressed a standalone closing think tag and preserved 2 tool call(s).',
        EVENT_PROTOCOL_TAG_SANITIZED,
        {
          model: 'test-model',
          prompt_id: 'prompt-id',
          response_id: 'response-id',
          tag_name: 'think',
          tool_call_count: 2,
        },
      );
      expect(JSON.stringify(mockLogger.emit.mock.calls[0])).not.toMatch(
        /response_text|reasoning|tool_name|arguments/,
      );
    });
  });

  describe('logMemoryRecall', () => {
    const SKIP_SELECTOR_EXPERIMENT_ENV =
      RECALL_SKIP_SELECTOR_ON_UNIQUE_STRONG_HIT_ENV;

    const makeRecallEvent = (selectorSkipped: boolean) =>
      new MemoryRecallEvent({
        query_length: 12,
        docs_scanned: 3,
        docs_selected: 1,
        strategy: 'heuristic',
        duration_ms: 42,
        selector_skipped: selectorSkipped,
      });

    beforeEach(() => {
      vi.spyOn(metrics, 'recordMemoryRecallMetrics');
    });

    afterEach(() => {
      delete process.env[SKIP_SELECTOR_EXPERIMENT_ENV];
    });

    it('keeps selector_skipped off the recall metrics while the #13003 experiment is disabled', () => {
      delete process.env[SKIP_SELECTOR_EXPERIMENT_ENV];
      const config = makeFakeConfig({ sessionId: 'test-session-id' });

      logMemoryRecall(config, makeRecallEvent(false));

      expect(metrics.recordMemoryRecallMetrics).toHaveBeenCalledWith(
        config,
        42,
        {
          strategy: 'heuristic',
          docs_selected: 1,
        },
      );
      // Only the metric dimensions are gated on the experiment.
      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Memory recall: strategy=heuristic. Selected 1/3 docs.',
        attributes: expect.objectContaining({ selector_skipped: false }),
      });
    });

    it.each([true, false])(
      'preserves selector_skipped=%s while enabled',
      (skipped) => {
        process.env[SKIP_SELECTOR_EXPERIMENT_ENV] = '1';
        const config = makeFakeConfig({ sessionId: 'test-session-id' });

        logMemoryRecall(config, makeRecallEvent(skipped));

        expect(metrics.recordMemoryRecallMetrics).toHaveBeenCalledWith(
          config,
          42,
          {
            strategy: 'heuristic',
            docs_selected: 1,
            selector_skipped: skipped,
          },
        );
        expect(mockLogger.emit.mock.lastCall?.[0].attributes).toHaveProperty(
          'selector_skipped',
          skipped,
        );
      },
    );

    it('omits selector_skipped when the recall had no skip decision', () => {
      // Legacy-mode recalls never reach the skip guard; stamping a constant
      // `false` there would mix a no-decision series into the experiment's
      // control arm.
      process.env[SKIP_SELECTOR_EXPERIMENT_ENV] = '1';
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      const event = makeRecallEvent(false);
      // The producer leaves the field unset for a legacy recall.
      event.selector_skipped = undefined;

      logMemoryRecall(config, event);

      expect(metrics.recordMemoryRecallMetrics).toHaveBeenCalledWith(
        config,
        42,
        {
          strategy: 'heuristic',
          docs_selected: 1,
        },
      );
      expect(mockLogger.emit.mock.lastCall?.[0].attributes).not.toHaveProperty(
        'selector_skipped',
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

      expectEmitted(
        'Memory recall delivery: phase=refined. delivery_point=discarded. Selected 2 doc(s).',
        EVENT_MEMORY_RECALL_DELIVERY,
        {
          phase: 'refined',
          delivery_point: 'discarded',
          discard_reason: 'reset',
          strategy: 'model',
          docs_selected: 2,
          latency_ms: 123,
          router_delivered: false,
        },
      );
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

  describe('memory migration telemetry', () => {
    it('records aggregate memory search telemetry without query content', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });

      logMemorySearch(
        config,
        new MemorySearchEvent({
          mode: 'search',
          docs_scanned: 12,
          results_returned: 3,
          duration_ms: 45,
        }),
      );

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Memory search: mode=search. Returned 3/12 docs.',
        attributes: expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_MEMORY_SEARCH,
          mode: 'search',
          docs_scanned: 12,
          results_returned: 3,
          duration_ms: 45,
        }),
      });
      expect(JSON.stringify(mockLogger.emit.mock.calls[0])).not.toMatch(
        /query|keyword|content|filePath|relativePath|sourceHash|secret/i,
      );
    });

    it('records aggregate migration cost without memory content', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      logMemoryMigration(
        config,
        new MemoryMigrationEvent({
          scope: 'project',
          status: 'completed',
          files_scanned: 12,
          legacy_files: 3,
          remaining_legacy_files: 1,
          batch_files: 3,
          committed: 2,
          conflicts: 1,
          failed: 0,
          agent_duration_ms: 400,
          input_tokens: 100,
          output_tokens: 20,
          total_tokens: 120,
          duration_ms: 450,
        }),
      );

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Memory metadata migration: scope=project. status=completed. Committed 2/3.',
        attributes: expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_MEMORY_MIGRATION,
          files_scanned: 12,
          legacy_files: 3,
          total_tokens: 120,
        }),
      });
      expect(
        JSON.stringify(mockLogger.emit.mock.calls[0]?.[0].attributes),
      ).not.toMatch(/keyword|memory-file|sourceHash|relativePath|content/i);
    });

    it('records recall mode transition outcomes without corpus identifiers', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      logMemoryRecallModeTransition(
        config,
        new MemoryRecallModeTransitionEvent({
          from_mode: 'legacy',
          to_mode: 'structured',
          status: 'committed',
          duration_ms: 12,
        }),
      );

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Memory recall mode transition: legacy -> structured. status=committed.',
        attributes: expect.objectContaining({
          'event.name': EVENT_MEMORY_RECALL_MODE_TRANSITION,
          from_mode: 'legacy',
          to_mode: 'structured',
          status: 'committed',
          duration_ms: 12,
        }),
      });
      expect(JSON.stringify(mockLogger.emit.mock.calls[0])).not.toMatch(
        /revision|hash|path|keyword|content/i,
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

      expectEmitted('CLI configuration loaded.', EVENT_CLI_CONFIG, {
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
      });
    });
  });

  describe('session lifecycle wiring', () => {
    // Distinct session ids per case: emitSessionStart is idempotent per id,
    // and the module-level guard persists across tests in this file.
    it('logStartSession emits the standard session.start record with lineage', () => {
      const mockConfig = makeFakeConfig({
        sessionId: 'lifecycle-start-session',
      });

      logStartSession(
        mockConfig,
        new StartSessionEvent(mockConfig),
        'previous-session-id',
      );

      expectEmitted(
        'Session started.',
        EVENT_SESSION_START,
        { 'session.previous_id': 'previous-session-id' },
        'lifecycle-start-session',
      );
    });

    it('logSessionEnd emits the standard session.end record', () => {
      logSessionEnd(makeFakeConfig({ sessionId: 'lifecycle-end-session' }));

      expectEmitted(
        'Session ended.',
        EVENT_SESSION_END,
        {},
        'lifecycle-end-session',
      );
    });

    it('does not emit or consume the session.start idempotency token while the SDK is uninitialized', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      const mockConfig = makeFakeConfig({ sessionId: 'suppressed-session' });

      logStartSession(mockConfig, new StartSessionEvent(mockConfig));
      logSessionEnd(mockConfig);

      expect(mockLogger.emit).not.toHaveBeenCalled();

      // The suppressed start must not consume the one-shot token: once the
      // SDK settles, the settle-time catch-up still emits the record.
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(true);
      logStartSession(mockConfig, new StartSessionEvent(mockConfig));

      expectEmitted(
        'Session started.',
        EVENT_SESSION_START,
        {},
        'suppressed-session',
      );
    });
  });

  describe('logRepeatedToolFailureGuard', () => {
    it('emits a data-minimized transition log and low-cardinality metric', () => {
      vi.spyOn(
        metrics,
        'recordRepeatedToolFailureGuardMetrics',
      ).mockImplementation(() => undefined);
      const event = new RepeatedToolFailureGuardEvent({
        prompt_id: 'prompt-id',
        route: 'acp_foreground',
        mode: 'shadow',
        phase_before: 'tracking',
        phase_after: 'warned',
        decision: 'would_warn',
        failure_count_bucket: '8+',
        batch_count_bucket: '2',
        candidate_ordinal: 1,
        terminal_status: 'error',
        execution_status: 'error',
        execution_error_type: ToolErrorType.EXECUTION_TIMEOUT,
        tool_type: 'mcp',
      });

      logRepeatedToolFailureGuard(event);

      expect(mockLogger.emit).toHaveBeenCalledWith({
        body: 'Repeated tool failure guard decision: would_warn.',
        attributes: {
          ...event,
          'event.name': EVENT_REPEATED_TOOL_FAILURE_GUARD,
        },
      });
      expect(
        metrics.recordRepeatedToolFailureGuardMetrics,
      ).toHaveBeenCalledWith({
        route: 'acp_foreground',
        mode: 'shadow',
        phase_before: 'tracking',
        phase_after: 'warned',
        decision: 'would_warn',
        failure_count_bucket: '8+',
        batch_count_bucket: '2',
        terminal_status: 'error',
        execution_status: 'error',
        tool_type: 'mcp',
      });
      const serialized = JSON.stringify(mockLogger.emit.mock.calls.at(-1));
      expect(serialized).not.toMatch(
        /session.id|user.id|policyToolName|function_args|result|error_message|server_name/,
      );
    });

    it('isolates transition log and metric sink failures', () => {
      const event = new RepeatedToolFailureGuardEvent({
        prompt_id: 'prompt-id',
        route: 'acp_foreground',
        mode: 'enforce',
        phase_before: 'warned',
        phase_after: 'latched',
        decision: 'stopped',
        failure_count_bucket: '8+',
        batch_count_bucket: '3+',
        candidate_ordinal: 1,
      });
      vi.spyOn(
        metrics,
        'recordRepeatedToolFailureGuardMetrics',
      ).mockImplementationOnce(throwing('metric unavailable'));
      mockLogger.emit.mockImplementationOnce(throwing('log unavailable'));

      expect(() => logRepeatedToolFailureGuard(event)).not.toThrow();
      for (const key of [
        'reset_reason',
        'terminal_status',
        'execution_status',
        'execution_error_type',
        'tool_type',
      ]) {
        expect(event).not.toHaveProperty(key);
      }
    });
  });

  describe('logLoopDetected', () => {
    // Runs `check` with QwenLogger.getInstance stubbed, restoring it after.
    const withLoopSink = (
      check: (sink: Mock, event: LoopDetectedEvent, config: Config) => void,
    ) => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      const logLoopDetectedEvent = vi.fn();
      const getInstanceSpy = vi
        .spyOn(QwenLogger, 'getInstance')
        .mockReturnValue({ logLoopDetectedEvent } as unknown as QwenLogger);
      const event = new LoopDetectedEvent(
        LoopType.REPEATED_TOOL_EXECUTION_FAILURE,
        'prompt-id',
      );
      try {
        check(logLoopDetectedEvent, event, config);
      } finally {
        getInstanceSpy.mockRestore();
      }
    };

    it('does not infer telemetry destinations from the loop type', () =>
      withLoopSink((sink, event, config) => {
        logLoopDetected(config, event);

        expect(sink).toHaveBeenCalledWith(event);
      }));

    it('supports explicitly keeping a loop event out of QwenLogger', () =>
      withLoopSink((sink, event, config) => {
        logLoopDetected(config, event, { recordToQwenLogger: false });

        expect(sink).not.toHaveBeenCalled();
        expect(mockLogger.emit).toHaveBeenCalledWith({
          body: `Loop detected. Type: ${LoopType.REPEATED_TOOL_EXECUTION_FAILURE}.`,
          attributes: { 'session.id': 'test-session-id', ...event },
        });
      }));
  });

  describe('logUserPrompt', () => {
    const mockConfig = cfg({
      getTelemetryEnabled: () => true,
      getTelemetryLogPromptsEnabled: () => true,
    });
    const expectPromptLogged = (
      config: Config,
      event: UserPromptEvent,
      attributes: Record<string, unknown>,
    ) => {
      logUserPrompt(config, event);
      expectEmitted('User prompt. Length: 11.', EVENT_USER_PROMPT, {
        prompt_length: 11,
        ...attributes,
      });
    };

    it('should log a user prompt', () =>
      expectPromptLogged(
        mockConfig,
        new UserPromptEvent(
          11,
          'prompt-id-8',
          AuthType.USE_VERTEX_AI,
          'test-prompt',
        ),
        {
          prompt: 'test-prompt',
          prompt_id: 'prompt-id-8',
          auth_type: 'vertex-ai',
        },
      ));

    it('should include the model attribute when set (e.g. inline override)', () =>
      expectPromptLogged(
        mockConfig,
        new UserPromptEvent(
          11,
          'prompt-id-model',
          AuthType.USE_OPENAI,
          'test-prompt',
          'qwen-max',
        ),
        {
          prompt: 'test-prompt',
          prompt_id: 'prompt-id-model',
          auth_type: 'openai',
          model: 'qwen-max',
        },
      ));

    it('should not log prompt if disabled', () =>
      expectPromptLogged(
        cfg({
          ...TELEMETRY_GETTERS,
          getTelemetryLogPromptsEnabled: () => false,
        }),
        new UserPromptEvent(
          11,
          'prompt-id-9',
          AuthType.USE_GEMINI,
          'test-prompt',
        ),
        { prompt_id: 'prompt-id-9', auth_type: 'gemini' },
      ));
  });

  describe('logApiResponse', () => {
    const mockConfig = cfg({
      ...TELEMETRY_GETTERS,
      getChatRecordingService: () => undefined,
    });

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

      expectEmitted(
        'API response from test-model. Status: 200. Duration: 100ms.',
        EVENT_API_RESPONSE,
        {
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
      );

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
          'event.timestamp': TS,
        },
        'test-session-id',
      );
      expect(
        tokenUsageService.recordTokenUsageFromApiResponseBestEffort,
      ).toHaveBeenCalledWith(mockConfig, event);
    });

    it('uses the request session snapshot when provided', () => {
      logApiResponse(
        mockConfig,
        new ApiResponseEvent(
          'test-response-id',
          'test-model',
          100,
          'prompt-id',
        ),
        'request-session-id',
      );

      expectRequestSessionId();
    });

    it('keeps task identity local to UI telemetry', () => {
      const event = new ApiResponseEvent(
        'test-response-id',
        'test-model',
        100,
        'prompt-id',
        undefined,
        undefined,
        undefined,
        'general-purpose',
      );

      logApiResponse(mockConfig, event, undefined, {
        id: 'general-purpose-12345678',
        type: 'general-purpose',
        taskName: 'inspect customer records',
      });

      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          subagent_name: 'general-purpose',
          subagent_id: 'general-purpose-12345678',
          subagent_task_name: 'inspect customer records',
        }),
        'test-session-id',
      );
      const attributes = mockLogger.emit.mock.calls[0]![0].attributes;
      expect(attributes.subagent_name).toBe('general-purpose');
      expect(attributes).not.toHaveProperty('subagent_id');
      expect(attributes).not.toHaveProperty('subagent_task_name');
    });

    const responseWithUsage = (promptId: string) =>
      new ApiResponseEvent(
        'test-response-id',
        'test-model',
        100,
        promptId,
        AuthType.USE_GEMINI,
        { promptTokenCount: 1, candidatesTokenCount: 2 },
      );

    it.each([
      'prompt_suggestion',
      'forked_query',
      'speculation',
      'side-query:session-title',
    ])('does not record token usage for internal prompt_id %s', (promptId) => {
      logApiResponse(mockConfig, responseWithUsage(promptId));

      expect(
        tokenUsageService.recordTokenUsageFromApiResponseBestEffort,
      ).not.toHaveBeenCalled();
    });

    it('does not record token usage when usage statistics are disabled', () => {
      const configWithUsageStatsDisabled = {
        ...mockConfig,
        getUsageStatisticsEnabled: () => false,
      } as unknown as Config;

      logApiResponse(
        configWithUsageStatsDisabled,
        responseWithUsage('prompt-id-1'),
      );

      expect(
        tokenUsageService.recordTokenUsageFromApiResponseBestEffort,
      ).not.toHaveBeenCalled();
    });
  });

  describe('logApiResponse skips chatRecordingService for internal prompt IDs', () => {
    // Logs a response through a recording config; returns the recording spy.
    const logResponse = (promptId: string, run = (fn: () => void) => fn()) => {
      const { record, config } = withRecording();
      run(() =>
        logApiResponse(
          config,
          new ApiResponseEvent('resp-id', 'test-model', 50, promptId),
        ),
      );
      return record;
    };

    it.each([
      'prompt_suggestion',
      'forked_query',
      'speculation',
      'side-query:session-title',
    ])(
      'should not record to chatRecordingService when prompt_id is %s',
      (promptId) => {
        expect(logResponse(promptId)).not.toHaveBeenCalled();
        expect(mockUiEvent.addEvent).toHaveBeenCalled();
      },
    );

    it('should record to chatRecordingService for normal prompt IDs', () => {
      expect(logResponse('user_query')).toHaveBeenCalled();
    });

    it('uses the request session snapshot when provided', () => {
      logApiError(
        makeFakeConfig({ sessionId: 'current-session-id' }),
        apiError('user_query'),
        'request-session-id',
      );

      expectRequestSessionId();
    });

    it('suppresses chatRecordingService writes inside hidden runs', () => {
      expect(
        logResponse('user_query', runWithChatRecordingSuppressed),
      ).not.toHaveBeenCalled();
      expect(mockUiEvent.addEvent).toHaveBeenCalled();
    });
  });

  describe('logApiError skips chatRecordingService for internal prompt IDs', () => {
    const logError = (promptId: string) => {
      const { record, config } = withRecording();
      logApiError(config, apiError(promptId));
      return record;
    };

    it.each(['prompt_suggestion', 'forked_query', 'speculation'])(
      'should not record to chatRecordingService when prompt_id is %s',
      (promptId) => {
        expect(logError(promptId)).not.toHaveBeenCalled();
      },
    );

    it('should record to chatRecordingService for normal prompt IDs', () => {
      expect(logError('user_query')).toHaveBeenCalled();
    });

    it('increments the api-activity error counter for the daemon health chart', () => {
      apiActivityTracker.drain(); // isolate from other cases (global singleton)
      logApiError(
        makeFakeConfig({ sessionId: 'test-session-id' }),
        apiError('user_query', 'boom'),
      );
      expect(apiActivityTracker.peek()).toEqual({ errors: 1, retries: 0 });
    });

    it('counts the error even when the OTel SDK is not initialized', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      apiActivityTracker.drain();
      logApiError(
        makeFakeConfig({ sessionId: 's' }),
        apiError('user_query', 'boom'),
      );
      // The daemon health chart is independent of OTel export state — the
      // counter is bumped before the SDK guard, mirroring logApiRetry.
      expect(apiActivityTracker.peek().errors).toBe(1);
    });
  });

  describe('logApiRequest', () => {
    const mockConfig = cfg(TELEMETRY_GETTERS);

    it('should log an API request with request_text', () => {
      logApiRequest(
        mockConfig,
        new ApiRequestEvent(
          'test-model',
          'prompt-id-7',
          'This is a test request',
        ),
      );

      expectEmitted('API request to test-model.', EVENT_API_REQUEST, {
        model: 'test-model',
        request_text: 'This is a test request',
        prompt_id: 'prompt-id-7',
      });
    });

    it('should log an API request without request_text', () => {
      logApiRequest(
        mockConfig,
        new ApiRequestEvent('test-model', 'prompt-id-6'),
      );

      expectEmitted('API request to test-model.', EVENT_API_REQUEST, {
        model: 'test-model',
        prompt_id: 'prompt-id-6',
      });
    });

    it('uses the request session snapshot when provided', () => {
      logApiRequest(
        mockConfig,
        new ApiRequestEvent('test-model', 'prompt-id'),
        'request-session-id',
      );

      expectRequestSessionId();
    });
  });

  describe('logFlashFallback', () => {
    it('should log flash fallback event', () => {
      logFlashFallback(cfg(), new FlashFallbackEvent(AuthType.USE_VERTEX_AI));

      expectEmitted('Switching to flash as Fallback.', EVENT_FLASH_FALLBACK, {
        auth_type: 'vertex-ai',
      });
    });
  });

  describe('logGoalState', () => {
    const mockConfig = cfg({
      getTelemetryMetricsIncludeSessionId: () => false,
    });

    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logGoalStateEvent');
      vi.spyOn(metrics, 'recordGoalStateMetrics');
    });

    it('emits the transition with its figures and records its metrics', () => {
      const event = makeGoalStateEvent({
        cause: 'usage_limited',
        goal_id: 'g-1',
        revision: 2,
        status: 'usage_limited',
        limit_kind: 'turn_budget',
        turn_count: 20,
        tokens_used: 1_234,
      });

      logGoalState(mockConfig, event);

      expectEmitted('Goal usage_limited.', EVENT_GOAL_STATE, {
        cause: 'usage_limited',
        goal_id: 'g-1',
        revision: 2,
        status: 'usage_limited',
        limit_kind: 'turn_budget',
        turn_count: 20,
        tokens_used: 1_234,
      });
      expect(QwenLogger.prototype.logGoalStateEvent).toHaveBeenCalledWith(
        event,
      );
      expect(metrics.recordGoalStateMetrics).toHaveBeenCalledWith(
        mockConfig,
        event,
      );
    });

    it('still reaches the analytics sink when the OpenTelemetry SDK is off', () => {
      vi.spyOn(sdk, 'isTelemetrySdkInitialized').mockReturnValue(false);
      const event = makeGoalStateEvent({
        cause: 'create',
        goal_id: 'g-1',
        revision: 1,
      });

      logGoalState(mockConfig, event);

      expect(QwenLogger.prototype.logGoalStateEvent).toHaveBeenCalledWith(
        event,
      );
      expect(mockLogger.emit).not.toHaveBeenCalled();
    });
  });

  describe('logRipgrepFallback', () => {
    beforeEach(() => {
      vi.spyOn(QwenLogger.prototype, 'logRipgrepFallbackEvent');
    });

    const expectFallbackLogged = (error: string) => {
      logRipgrepFallback(cfg(), new RipgrepFallbackEvent(false, false, error));

      expect(QwenLogger.prototype.logRipgrepFallbackEvent).toHaveBeenCalled();

      const emittedEvent = mockLogger.emit.mock.calls[0][0];
      expect(emittedEvent.body).toBe('Switching to grep as fallback.');
      expect(emittedEvent.attributes).toEqual(
        expect.objectContaining({
          'session.id': 'test-session-id',
          'event.name': EVENT_RIPGREP_FALLBACK,
          error,
        }),
      );
    };

    it('should log ripgrep fallback event', () =>
      expectFallbackLogged('ripgrep is not available'));

    it('should log ripgrep fallback event with an error', () =>
      expectFallbackLogged('rg not found'));
  });

  describe('logRipgrepRuntimeRecovery', () => {
    const mockConfig = cfg();

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
    const mockConfig = cfg();

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
      getLlmClient: () => mockLlmClient,
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

    const mockLlmClient = new LlmClient(cfg2);
    const mockConfig = cfg({
      ...TELEMETRY_GETTERS,
      getLlmClient: () => mockLlmClient,
      getChatRecordingService: () => undefined,
    });

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

    const DIFF_STAT = {
      model_added_lines: 1,
      model_removed_lines: 2,
      model_added_chars: 3,
      model_removed_chars: 4,
      user_added_lines: 5,
      user_removed_lines: 6,
      user_added_chars: 7,
      user_removed_chars: 8,
    };
    // An event literal, as handed over by producers other than ToolCallEvent.
    const rawEvent = (fields: Partial<ToolCallEvent>) =>
      ({
        'event.name': 'tool_call',
        'event.timestamp': TS,
        function_args: {},
        tool_type: 'native',
        ...fields,
      }) as ToolCallEvent;
    const recordingConfig = (recordUiTelemetryEvent: unknown = vi.fn()) =>
      ({
        ...mockConfig,
        getChatRecordingService: () => ({ recordUiTelemetryEvent }),
      }) as unknown as Config;
    const expectExecutionMetric = (config: Config, execution_status: string) =>
      expect(mockMetrics.recordToolExecutionMetrics).toHaveBeenCalledWith(
        config,
        { execution_status, tool_type: 'native' },
      );
    const expectQwenAndUiEvents = (normalized: unknown) => {
      expect(QwenLogger.prototype.logToolCallEvent).toHaveBeenCalledWith(
        normalized,
      );
      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        normalized,
        'test-session-id',
      );
    };
    const request = (
      prompt_id: string,
      fields: Partial<ToolCallRequestInfo> = {},
    ): ToolCallRequestInfo => ({
      name: 'test-function',
      args: { arg1: 'value1', arg2: 2 },
      callId: 'test-call-id',
      isClientInitiated: true,
      prompt_id,
      ...fields,
    });
    const response = (
      executionStatus: ToolExecutionStatus,
      fields: Partial<ToolCallResponseInfo> = {},
    ): ToolCallResponseInfo => ({
      callId: 'test-call-id',
      responseParts: [{ text: 'test-response' }],
      resultDisplay: undefined,
      error: undefined,
      errorType: undefined,
      ...fields,
      executionStatus,
    });
    const logCall = (call: CompletedToolCall, config = mockConfig) => {
      const event = new ToolCallEvent(call);
      logToolCall(config, event);
      return event;
    };
    // Checks the OTel record of a `test-call-id` call built by `request()`
    // and, unless `otelOnly`, its legacy metric and UI event.
    const expectToolCallLogged = (
      event: ToolCallEvent,
      body: string,
      attributes: Record<string, unknown>,
      otelOnly = false,
    ) => {
      expectEmitted(body, EVENT_TOOL_CALL, {
        call_id: 'test-call-id',
        function_name: 'test-function',
        function_args: JSON.stringify({ arg1: 'value1', arg2: 2 }, null, 2),
        duration_ms: 100,
        tool_type: 'native',
        ...attributes,
      });
      if (otelOnly) return;
      const { status, success, decision } = attributes;
      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalledWith(
        mockConfig,
        100,
        {
          function_name: 'test-function',
          status,
          success,
          decision,
          tool_type: 'native',
        },
      );
      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        {
          ...normalizeToolCallEvent(event),
          'event.name': EVENT_TOOL_CALL,
          'event.timestamp': TS,
        },
        'test-session-id',
      );
    };

    it('normalizes an unclassified error before every consumer', () => {
      const recordUiTelemetryEvent = vi.fn();
      const configWithRecording = recordingConfig(recordUiTelemetryEvent);
      const event = rawEvent({
        function_name: '   ',
        function_args: { value: 1 },
        duration_ms: 25,
        status: 'error',
        success: true,
        error: 'failed',
        error_type: ' ',
        prompt_id: 'prompt-normalize',
      });

      logToolCall(configWithRecording, event);

      const normalized = expect.objectContaining({
        function_name: 'unknown_tool',
        status: 'error',
        success: false,
        execution_status: 'unknown',
        error: 'failed',
        error_type: ToolErrorType.UNKNOWN,
      });
      expectQwenAndUiEvents(normalized);
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
      expectExecutionMetric(configWithRecording, 'unknown');
      expect(event).not.toHaveProperty('execution_status');
      expect(event.function_name).toBe('   ');
      expect(event.success).toBe(true);
      expect(event.error_type).toBe(' ');
    });

    it('records when the call started, as the scheduler measured it', () => {
      const recordUiTelemetryEvent = vi.fn();
      logCall(
        {
          status: 'success',
          request: request('prompt-started', {
            name: 'glob',
            args: {},
            callId: 'call-started',
            isClientInitiated: false,
          }),
          response: response('success', {
            callId: 'call-started',
            responseParts: [],
          }),
          tool: new EditTool(mockConfig),
          invocation: {} as AnyToolInvocation,
          startTime: 1_760_000_000_000,
          durationMs: 16,
        },
        recordingConfig(recordUiTelemetryEvent),
      );

      const started = expect.objectContaining({
        started_at_ms: 1_760_000_000_000,
        duration_ms: 16,
      });
      expect(recordUiTelemetryEvent).toHaveBeenCalledWith(started);
      expect(mockUiEvent.addEvent).toHaveBeenCalledWith(
        started,
        'test-session-id',
      );
    });

    it('records no start for a call that never started', () => {
      const call: CompletedToolCall = {
        status: 'cancelled',
        request: request('prompt-unstarted', {
          name: 'glob',
          args: {},
          callId: 'call-unstarted',
          isClientInitiated: false,
        }),
        response: response('not_started', {
          callId: 'call-unstarted',
          responseParts: [],
        }),
        durationMs: 0,
      };

      expect(new ToolCallEvent(call).started_at_ms).toBeUndefined();
    });

    it('clears call errors when cancellation is the final outcome', () => {
      const event = rawEvent({
        function_name: 'shell',
        duration_ms: 1,
        status: 'cancelled',
        execution_status: 'cancelled',
        success: true,
        error: 'cancelled by user',
        error_type: ToolErrorType.UNHANDLED_EXCEPTION,
        prompt_id: 'prompt-id',
      });

      const normalized = normalizeToolCallEvent(event);

      expect(normalized.success).toBe(false);
      expect(normalized).not.toHaveProperty('error');
      expect(normalized).not.toHaveProperty('error_type');
      expect(event.error).toBe('cancelled by user');
    });

    it('preserves a nonblank function name byte-for-byte', () => {
      const event = rawEvent({
        function_name: '  padded_tool  ',
        duration_ms: 1,
        status: 'success',
        success: true,
        prompt_id: 'prompt-padded',
      });

      expect(normalizeToolCallEvent(event).function_name).toBe(
        '  padded_tool  ',
      );
    });

    it('preserves an explicitly classified error type', () => {
      logToolCall(
        mockConfig,
        rawEvent({
          function_name: 'test-function',
          duration_ms: 10,
          status: 'error',
          success: false,
          error: 'classified failure',
          error_type: ToolErrorType.EXECUTION_FAILED,
          prompt_id: 'prompt-classified',
        }),
      );

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
      const configWithRecording = recordingConfig();
      const event = rawEvent({
        function_name: 'legacy_tool',
        duration_ms: 42,
        status: 'success',
        success: true,
        prompt_id: 'prompt-legacy',
      });

      expect(event).not.toHaveProperty('execution_status');

      logToolCall(configWithRecording, event);

      expectExecutionMetric(configWithRecording, 'unknown');
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
        logToolCall(
          mockConfig,
          rawEvent({
            function_name: 'test-function',
            duration_ms: 10,
            status,
            success: !expectedSuccess,
            error: 'stale error',
            error_type: ToolErrorType.EXECUTION_FAILED,
            prompt_id: 'prompt-terminal',
          }),
        );

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
      logToolCall(
        mockConfig,
        rawEvent({
          function_name: '',
          duration_ms: 10,
          status: 'error',
          success: true,
          prompt_id: 'prompt-no-otel',
        }),
      );

      expectQwenAndUiEvents(
        expect.objectContaining({
          function_name: 'unknown_tool',
          status: 'error',
          success: false,
          execution_status: 'unknown',
          error_type: ToolErrorType.UNKNOWN,
        }),
      );
      expect(mockLogger.emit).not.toHaveBeenCalled();
      expect(mockMetrics.recordToolCallMetrics).not.toHaveBeenCalled();
      expect(mockMetrics.recordToolExecutionMetrics).not.toHaveBeenCalled();
    });

    it('isolates every tool-call telemetry sink failure', () => {
      const chatSink = vi.fn(throwing('chat sink failed'));
      const qwenSink = vi.fn(throwing('qwen sink failed'));
      const qwenLoggerSpy = vi
        .spyOn(QwenLogger, 'getInstance')
        .mockReturnValue({
          logToolCallEvent: qwenSink,
        } as unknown as QwenLogger);
      mockUiEvent.addEvent.mockImplementationOnce(throwing('ui sink failed'));
      mockLogger.emit.mockImplementationOnce(throwing('otel sink failed'));
      mockMetrics.recordToolCallMetrics.mockImplementationOnce(
        throwing('legacy metric sink failed'),
      );
      mockMetrics.recordToolExecutionMetrics.mockImplementationOnce(
        throwing('execution metric sink failed'),
      );
      const config = recordingConfig(chatSink);
      const event = rawEvent({
        call_id: 'call-id',
        function_name: 'read_file',
        duration_ms: 1,
        status: 'success',
        execution_status: 'success',
        success: true,
        prompt_id: 'prompt-id',
      });

      expect(() => logToolCall(config, event)).not.toThrow();
      expect(mockUiEvent.addEvent).toHaveBeenCalled();
      expect(chatSink).toHaveBeenCalled();
      expect(qwenSink).toHaveBeenCalled();
      expect(mockLogger.emit).toHaveBeenCalled();
      expect(mockMetrics.recordToolCallMetrics).toHaveBeenCalled();
      expectExecutionMetric(config, 'success');
      qwenLoggerSpy.mockRestore();
    });

    it('should log a tool call with all fields', () => {
      const event = logCall({
        status: 'success',
        request: request('prompt-id-1'),
        response: response('success', {
          resultDisplay: {
            fileDiff: 'diff',
            fileName: 'file.txt',
            originalContent: 'old content',
            newContent: 'new content',
            diffStat: { ...DIFF_STAT },
          },
          contentLength: 13,
        }),
        tool: new EditTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
        outcome: ToolConfirmationOutcome.ProceedOnce,
      });

      expectToolCallLogged(
        event,
        'Tool call: test-function. Decision: accept. Success: true. Duration: 100ms.',
        {
          status: 'success',
          execution_status: 'success',
          success: true,
          decision: ToolCallDecision.ACCEPT,
          prompt_id: 'prompt-id-1',
          metadata: DIFF_STAT,
          content_length: 13,
        },
      );
      expectExecutionMetric(mockConfig, 'success');
    });

    it('should log a tool call with a reject decision', () => {
      const event = logCall({
        status: 'error',
        request: request('prompt-id-2'),
        response: response('not_started', { contentLength: undefined }),
        durationMs: 100,
        outcome: ToolConfirmationOutcome.Cancel,
      });

      expectToolCallLogged(
        event,
        'Tool call: test-function. Decision: reject. Success: false. Duration: 100ms.',
        {
          status: 'error',
          execution_status: 'not_started',
          success: false,
          decision: ToolCallDecision.REJECT,
          prompt_id: 'prompt-id-2',
          error: undefined,
          error_type: ToolErrorType.UNKNOWN,
          'error.type': ToolErrorType.UNKNOWN,
        },
      );
    });

    it('should log a tool call with a modify decision', () => {
      const event = logCall({
        status: 'success',
        request: request('prompt-id-3'),
        response: response('success', { contentLength: 13 }),
        outcome: ToolConfirmationOutcome.ModifyWithEditor,
        tool: new EditTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
      });

      expectToolCallLogged(
        event,
        'Tool call: test-function. Decision: modify. Success: true. Duration: 100ms.',
        {
          status: 'success',
          execution_status: 'success',
          success: true,
          decision: ToolCallDecision.MODIFY,
          prompt_id: 'prompt-id-3',
          content_length: 13,
        },
      );
    });

    it('should log a tool call without a decision', () => {
      const event = logCall({
        status: 'success',
        request: request('prompt-id-4'),
        response: response('success', { contentLength: 13 }),
        tool: new EditTool(mockConfig),
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
      });

      expectToolCallLogged(
        event,
        'Tool call: test-function. Success: true. Duration: 100ms.',
        {
          status: 'success',
          execution_status: 'success',
          success: true,
          prompt_id: 'prompt-id-4',
          content_length: 13,
        },
      );
    });

    it('should log a failed tool call with an error', () => {
      const errorMessage = 'test-error';
      const event = logCall({
        status: 'error',
        request: request('prompt-id-5'),
        response: response('error', {
          error: new Error(errorMessage),
          errorType: ToolErrorType.UNKNOWN,
          contentLength: errorMessage.length,
        }),
        durationMs: 100,
      });

      expectToolCallLogged(
        event,
        'Tool call: test-function. Success: false. Duration: 100ms.',
        {
          status: 'error',
          execution_status: 'error',
          success: false,
          error: 'test-error',
          'error.message': 'test-error',
          error_type: ToolErrorType.UNKNOWN,
          'error.type': ToolErrorType.UNKNOWN,
          prompt_id: 'prompt-id-5',
          content_length: errorMessage.length,
        },
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

      const event = logCall({
        status: 'success',
        request: request('prompt-id', { name: 'mock_mcp_tool' }),
        response: response('success'),
        tool: mockMcpTool,
        invocation: {} as AnyToolInvocation,
        durationMs: 100,
      });

      expectToolCallLogged(
        event,
        'Tool call: mock_mcp_tool. Success: true. Duration: 100ms.',
        {
          function_name: 'mock_mcp_tool',
          status: 'success',
          execution_status: 'success',
          success: true,
          prompt_id: 'prompt-id',
          tool_type: 'mcp',
          mcp_server_name: 'mock_mcp_server',
        },
        true,
      );
    });

    it.each(['prompt_suggestion', 'forked_query', 'speculation'])(
      'should not record to chatRecordingService when prompt_id is %s',
      (promptId) => {
        const mockRecordUiTelemetryEvent = vi.fn();
        logCall(
          {
            status: 'success',
            request: request(promptId, { args: {} }),
            response: response('success', { responseParts: [{ text: 'ok' }] }),
            tool: new EditTool(mockConfig),
            invocation: {} as AnyToolInvocation,
            durationMs: 50,
            outcome: ToolConfirmationOutcome.ProceedOnce,
          },
          recordingConfig(mockRecordUiTelemetryEvent),
        );

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
      expectEmitted(
        'Malformed JSON response from test-model.',
        EVENT_MALFORMED_JSON_RESPONSE,
        { model: 'test-model' },
      );
    });
  });

  describe('logFileOperation', () => {
    const mockConfig = cfg(TELEMETRY_GETTERS);
    const mockMetrics = { recordFileOperationMetric: vi.fn() };

    beforeEach(() => {
      vi.spyOn(metrics, 'recordFileOperationMetric').mockImplementation(
        mockMetrics.recordFileOperationMetric,
      );
    });

    it('should log a file operation event', () => {
      logFileOperation(
        mockConfig,
        new FileOperationEvent(
          'test-tool',
          FileOperation.READ,
          10,
          'text/plain',
          '.txt',
          'typescript',
        ),
      );

      expectEmitted('File operation: read. Lines: 10.', EVENT_FILE_OPERATION, {
        tool_name: 'test-tool',
        operation: 'read',
        lines: 10,
        mimetype: 'text/plain',
        extension: '.txt',
        programming_language: 'typescript',
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
    it('should log a tool output truncated event', () => {
      logToolOutputTruncated(
        cfg(),
        new ToolOutputTruncatedEvent('prompt-id-1', {
          toolName: 'test-tool',
          originalContentLength: 1000,
          truncatedContentLength: 100,
          threshold: 500,
          lines: 10,
        }),
      );

      expectEmitted(
        'Tool output truncated for test-tool.',
        EVENT_TOOL_OUTPUT_TRUNCATED,
        {
          eventName: 'tool_output_truncated',
          prompt_id: 'prompt-id-1',
          tool_name: 'test-tool',
          original_content_length: 1000,
          truncated_content_length: 100,
          threshold: 500,
          lines: 10,
        },
      );
    });
  });

  describe.each([
    [
      'logExtensionInstall',
      'install',
      'logExtensionInstallEvent',
      () => new ExtensionInstallEvent('vscode', '0.1.0', 'git', 'success'),
      logExtensionInstallEvent,
      'Installed extension vscode',
      EVENT_EXTENSION_INSTALL,
      {
        extension_name: 'vscode',
        extension_version: '0.1.0',
        extension_source: 'git',
        status: 'success',
      },
    ],
    [
      'logExtensionUninstall',
      'uninstall',
      'logExtensionUninstallEvent',
      () => new ExtensionUninstallEvent('vscode', 'success'),
      logExtensionUninstall,
      'Uninstalled extension vscode',
      EVENT_EXTENSION_UNINSTALL,
      { extension_name: 'vscode', status: 'success' },
    ],
    [
      'logExtensionEnable',
      'enable',
      'logExtensionEnableEvent',
      () => new ExtensionEnableEvent('vscode', 'user'),
      logExtensionEnable,
      'Enabled extension vscode',
      EVENT_EXTENSION_ENABLE,
      { extension_name: 'vscode', setting_scope: 'user' },
    ],
    [
      'logExtensionDisable',
      'disable',
      'logExtensionDisableEvent',
      () => new ExtensionDisableEvent('vscode', 'user'),
      logExtensionDisable,
      'Disabled extension vscode',
      EVENT_EXTENSION_DISABLE,
      { extension_name: 'vscode', setting_scope: 'user' },
    ],
  ] as const)(
    '%s',
    (_name, verb, method, makeEvent, log, body, eventName, attributes) => {
      const mockConfig = cfg();

      beforeEach(() => {
        vi.spyOn(QwenLogger.prototype, method);
      });

      afterEach(() => {
        vi.resetAllMocks();
      });

      it(`should log extension ${verb} event`, () => {
        const event = makeEvent();

        log(mockConfig, event as never);

        expect(QwenLogger.prototype[method]).toHaveBeenCalledWith(event);
        expectEmitted(body, eventName, attributes);
      });
    },
  );

  describe('logHookCall', () => {
    const mockConfig = cfg(TELEMETRY_GETTERS);
    const mockQwenLogger = { logHookCallEvent: vi.fn() };

    beforeEach(() => {
      vi.spyOn(QwenLogger, 'getInstance').mockReturnValue(
        mockQwenLogger as unknown as QwenLogger,
      );
      mockQwenLogger.logHookCallEvent.mockClear();
    });

    const expectHookLogged = (
      ...args: ConstructorParameters<typeof HookCallEvent>
    ) => {
      const event = new HookCallEvent(...args);
      logHookCall(mockConfig, event);
      expect(mockQwenLogger.logHookCallEvent).toHaveBeenCalledWith(event);
    };

    it('should log a successful hook call to QwenLogger', () =>
      expectHookLogged(
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
      ));

    it('should log a failed hook call with error', () =>
      expectHookLogged(
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
      ));

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

      expect(() => logHookCall(mockConfig, event)).not.toThrow();
    });

    it('should log hook call with all optional fields', () =>
      expectHookLogged(
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
      ));

    it('should log hook call with minimal fields', () =>
      expectHookLogged('SessionStart', 'command', 'init.sh', {}, 10, true));

    it('should log hook call with exit code', () =>
      expectHookLogged(
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
      ));

    it('should log hook call with zero exit code on success', () =>
      expectHookLogged(
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
      ));

    it('should log hook call with non-zero exit code on failure', () =>
      expectHookLogged(
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
      ));

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
        expectHookLogged(eventType, 'command', 'test-hook.sh', {}, 100, true);
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

    const buildEvent = (subagentName?: string) =>
      new ApiRetryEvent({
        model: 'qwen3',
        promptId: 'p-1',
        attemptNumber: 2,
        error: new Error('rate limited'),
        statusCode: 429,
        retryDelayMs: 1500,
        subagentName,
      });

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
      const event = buildEvent('explore-agent');
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
