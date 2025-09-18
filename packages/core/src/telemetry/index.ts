/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum TelemetryTarget {
  GCP = 'gcp',
  LOCAL = 'local',
  QWEN = 'qwen',
}

const DEFAULT_TELEMETRY_TARGET = TelemetryTarget.LOCAL;
const DEFAULT_OTLP_ENDPOINT = 'http://localhost:4317';

export { SpanStatusCode, ValueType } from '@opentelemetry/api';
export { SemanticAttributes } from '@opentelemetry/semantic-conventions';
export {
  logApiError,
  logApiRequest,
  logApiResponse,
  logChatCompression,
  logCliConfiguration,
  logConversationFinishedEvent,
  logFlashFallback,
  logKittySequenceOverflow,
  logSlashCommand,
  logToolCall,
  logUserPrompt,
} from './loggers.js';
export {
  initializeTelemetry,
  isTelemetrySdkInitialized,
  shutdownTelemetry,
} from './sdk.js';
export {
  ApiErrorEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  ConversationFinishedEvent,
  EndSessionEvent,
  FlashFallbackEvent,
  KittySequenceOverflowEvent,
  makeChatCompressionEvent,
  makeSlashCommandEvent,
  SlashCommandStatus,
  StartSessionEvent,
  ToolCallEvent,
  UserPromptEvent,
} from './types.js';
export type {
  ChatCompressionEvent,
  SlashCommandEvent,
  TelemetryEvent,
} from './types.js';
export * from './uiTelemetry.js';
export { DEFAULT_OTLP_ENDPOINT, DEFAULT_TELEMETRY_TARGET };
