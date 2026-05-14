/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum TelemetryTarget {
  GCP = 'gcp',
  LOCAL = 'local',
}

const DEFAULT_TELEMETRY_TARGET = TelemetryTarget.LOCAL;
const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4317';

export { DEFAULT_TELEMETRY_TARGET, DEFAULT_OTLP_ENDPOINT };
export {
  initializeTelemetry,
  shutdownTelemetry,
  refreshSessionContext,
  isTelemetrySdkInitialized,
} from './sdk.js';
export {
  resolveTelemetrySettings,
  parseBooleanEnvFlag,
  parseTelemetryTargetValue,
} from './config.js';
export {
  logStartSession,
  logUserPrompt,
  logUserRetry,
  logToolCall,
  logApiRequest,
  logApiError,
  logApiCancel,
  logApiResponse,
  logFlashFallback,
  logSlashCommand,
  logConversationFinishedEvent,
  logKittySequenceOverflow,
  logChatCompression,
  logToolOutputTruncated,
  logExtensionEnable,
  logExtensionInstallEvent,
  logExtensionUninstall,
  logExtensionDisable,
  logExtensionUpdateEvent,
  logRipgrepFallback,
  logNextSpeakerCheck,
  logAuth,
  logSkillLaunch,
  logUserFeedback,
  logArenaSessionStarted,
  logArenaAgentCompleted,
  logArenaSessionEnded,
  logMemoryExtract,
  logMemoryDream,
  logMemoryRecall,
} from './loggers.js';
export type { SlashCommandEvent, ChatCompressionEvent } from './types.js';
export {
  SlashCommandStatus,
  EndSessionEvent,
  UserPromptEvent,
  UserRetryEvent,
  ApiRequestEvent,
  ApiErrorEvent,
  ApiResponseEvent,
  ApiCancelEvent,
  FlashFallbackEvent,
  StartSessionEvent,
  ToolCallEvent,
  ConversationFinishedEvent,
  KittySequenceOverflowEvent,
  ToolOutputTruncatedEvent,
  RipgrepFallbackEvent,
  NextSpeakerCheckEvent,
  AuthEvent,
  SkillLaunchEvent,
  UserFeedbackEvent,
  UserFeedbackRating,
  makeArenaSessionStartedEvent,
  makeArenaAgentCompletedEvent,
  makeArenaSessionEndedEvent,
  MemoryExtractEvent,
  MemoryDreamEvent,
  MemoryRecallEvent,
} from './types.js';
export { makeSlashCommandEvent, makeChatCompressionEvent } from './types.js';
export type {
  ArenaSessionStartedEvent,
  ArenaAgentCompletedEvent,
  ArenaSessionEndedEvent,
  ArenaSessionEndedStatus,
  ArenaAgentCompletedStatus,
} from './types.js';
export type { TelemetryEvent } from './types.js';
export { SpanStatusCode, ValueType } from '@opentelemetry/api';
export { SemanticAttributes } from '@opentelemetry/semantic-conventions';
export * from './uiTelemetry.js';
export {
  // Core metrics functions
  recordToolCallMetrics,
  recordTokenUsageMetrics,
  recordApiResponseMetrics,
  recordApiErrorMetrics,
  recordFileOperationMetric,
  recordInvalidChunk,
  recordContentRetry,
  recordContentRetryFailure,
  // Performance monitoring functions
  recordStartupPerformance,
  recordMemoryUsage,
  recordCpuUsage,
  recordToolQueueDepth,
  recordToolExecutionBreakdown,
  recordTokenEfficiency,
  recordApiRequestBreakdown,
  recordPerformanceScore,
  recordPerformanceRegression,
  recordBaselineComparison,
  isPerformanceMonitoringActive,
  // Arena metrics functions
  recordArenaSessionStartedMetrics,
  recordArenaAgentCompletedMetrics,
  recordArenaSessionEndedMetrics,
  // Auto-Memory metrics functions
  recordMemoryExtractMetrics,
  recordMemoryDreamMetrics,
  recordMemoryRecallMetrics,
  // Performance monitoring types
  PerformanceMetricType,
  MemoryMetricType,
  ToolExecutionPhase,
  ApiRequestPhase,
  FileOperation,
} from './metrics.js';
export { QwenLogger } from './qwen-logger/qwen-logger.js';
export { sanitizeHookName } from './sanitize.js';
export {
  startInteractionSpan,
  endInteractionSpan,
  startLLMRequestSpan,
  endLLMRequestSpan,
  startToolSpan,
  endToolSpan,
  startToolExecutionSpan,
  endToolExecutionSpan,
  clearSessionTracingForTesting,
} from './session-tracing.js';
export type {
  StartInteractionOptions,
  EndInteractionOptions,
  LLMRequestMetadata,
  ToolSpanMetadata,
} from './session-tracing.js';
