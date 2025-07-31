/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { logs, LogRecord, LogAttributes } from '@opentelemetry/api-logs';
import { trace, context } from '@opentelemetry/api';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import { Config } from '../config/config.js';
import {
  EVENT_API_ERROR,
  EVENT_API_REQUEST,
  EVENT_API_RESPONSE,
  EVENT_CLI_CONFIG,
  EVENT_TOOL_CALL,
  EVENT_USER_PROMPT,
  EVENT_FLASH_FALLBACK,
  SERVICE_NAME,
} from './constants.js';
import {
  ApiErrorEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  StartSessionEvent,
  ToolCallEvent,
  UserPromptEvent,
  FlashFallbackEvent,
  LoopDetectedEvent,
} from './types.js';
import {
  recordApiErrorMetrics,
  recordTokenUsageMetrics,
  recordApiResponseMetrics,
  recordToolCallMetrics,
} from './metrics.js';
import { isTelemetrySdkInitialized } from './sdk.js';
import { uiTelemetryService, UiEvent } from './uiTelemetry.js';
// import { ClearcutLogger } from './clearcut-logger/clearcut-logger.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';

const shouldLogUserPrompts = (config: Config): boolean =>
  config.getTelemetryLogPromptsEnabled();

function getCommonAttributes(config: Config): LogAttributes {
  return {
    'session.id': config.getSessionId(),
  };
}

// Helper function to create spans and emit logs within span context
function logWithSpan(
  spanName: string,
  logBody: string,
  attributes: LogAttributes,
): void {
  const tracer = trace.getTracer(SERVICE_NAME);
  const span = tracer.startSpan(spanName);

  context.with(trace.setSpan(context.active(), span), () => {
    const logger = logs.getLogger(SERVICE_NAME);
    const logRecord: LogRecord = {
      body: logBody,
      attributes,
    };
    logger.emit(logRecord);
  });

  span.end();
}

export function logCliConfiguration(
  config: Config,
  event: StartSessionEvent,
): void {
  // ClearcutLogger.getInstance(config)?.logStartSessionEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_CLI_CONFIG,
    'event.timestamp': new Date().toISOString(),
    model: event.model,
    embedding_model: event.embedding_model,
    sandbox_enabled: event.sandbox_enabled,
    core_tools_enabled: event.core_tools_enabled,
    approval_mode: event.approval_mode,
    api_key_enabled: event.api_key_enabled,
    vertex_ai_enabled: event.vertex_ai_enabled,
    log_user_prompts_enabled: event.telemetry_log_user_prompts_enabled,
    file_filtering_respect_git_ignore: event.file_filtering_respect_git_ignore,
    debug_mode: event.debug_enabled,
    mcp_servers: event.mcp_servers,
  };

  logWithSpan('cli.configuration', 'CLI configuration loaded.', attributes);
}

export function logUserPrompt(config: Config, event: UserPromptEvent): void {
  // ClearcutLogger.getInstance(config)?.logNewPromptEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    'event.name': EVENT_USER_PROMPT,
    'event.timestamp': new Date().toISOString(),
    prompt_length: event.prompt_length,
  };

  if (shouldLogUserPrompts(config)) {
    attributes.prompt = event.prompt;
  }

  logWithSpan(
    'user.prompt',
    `User prompt. Length: ${event.prompt_length}.`,
    attributes,
  );
}

export function logToolCall(config: Config, event: ToolCallEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_TOOL_CALL,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent);
  // ClearcutLogger.getInstance(config)?.logToolCallEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_TOOL_CALL,
    'event.timestamp': new Date().toISOString(),
    function_args: safeJsonStringify(event.function_args, 2),
  };
  if (event.error) {
    attributes['error.message'] = event.error;
    if (event.error_type) {
      attributes['error.type'] = event.error_type;
    }
  }

  logWithSpan(
    `tool.${event.function_name}`,
    `Tool call: ${event.function_name}${event.decision ? `. Decision: ${event.decision}` : ''}. Success: ${event.success}. Duration: ${event.duration_ms}ms.`,
    attributes,
  );
  recordToolCallMetrics(
    config,
    event.function_name,
    event.duration_ms,
    event.success,
    event.decision,
  );
}

export function logApiRequest(config: Config, event: ApiRequestEvent): void {
  // ClearcutLogger.getInstance(config)?.logApiRequestEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_REQUEST,
    'event.timestamp': new Date().toISOString(),
  };

  logWithSpan(
    `api.request.${event.model}`,
    `API request to ${event.model}.`,
    attributes,
  );
}

export function logFlashFallback(
  config: Config,
  event: FlashFallbackEvent,
): void {
  // ClearcutLogger.getInstance(config)?.logFlashFallbackEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_FLASH_FALLBACK,
    'event.timestamp': new Date().toISOString(),
  };

  logWithSpan(
    'api.flash_fallback',
    'Switching to flash as Fallback.',
    attributes,
  );
}

export function logApiError(config: Config, event: ApiErrorEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_API_ERROR,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent);
  // ClearcutLogger.getInstance(config)?.logApiErrorEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_ERROR,
    'event.timestamp': new Date().toISOString(),
    ['error.message']: event.error,
    model_name: event.model,
    duration: event.duration_ms,
  };

  if (event.error_type) {
    attributes['error.type'] = event.error_type;
  }
  if (typeof event.status_code === 'number') {
    attributes[SemanticAttributes.HTTP_STATUS_CODE] = event.status_code;
  }

  logWithSpan(
    `api.error.${event.model}`,
    `API error for ${event.model}. Error: ${event.error}. Duration: ${event.duration_ms}ms.`,
    attributes,
  );
  recordApiErrorMetrics(
    config,
    event.model,
    event.duration_ms,
    event.status_code,
    event.error_type,
  );
}

export function logApiResponse(config: Config, event: ApiResponseEvent): void {
  const uiEvent = {
    ...event,
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': new Date().toISOString(),
  } as UiEvent;
  uiTelemetryService.addEvent(uiEvent);
  // ClearcutLogger.getInstance(config)?.logApiResponseEvent(event);
  if (!isTelemetrySdkInitialized()) return;
  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
    'event.name': EVENT_API_RESPONSE,
    'event.timestamp': new Date().toISOString(),
  };
  if (event.response_text) {
    attributes.response_text = event.response_text;
  }
  if (event.error) {
    attributes['error.message'] = event.error;
  } else if (event.status_code) {
    if (typeof event.status_code === 'number') {
      attributes[SemanticAttributes.HTTP_STATUS_CODE] = event.status_code;
    }
  }

  logWithSpan(
    `api.response.${event.model}`,
    `API response from ${event.model}. Status: ${event.status_code || 'N/A'}. Duration: ${event.duration_ms}ms.`,
    attributes,
  );
  recordApiResponseMetrics(
    config,
    event.model,
    event.duration_ms,
    event.status_code,
    event.error,
  );
  recordTokenUsageMetrics(
    config,
    event.model,
    event.input_token_count,
    'input',
  );
  recordTokenUsageMetrics(
    config,
    event.model,
    event.output_token_count,
    'output',
  );
  recordTokenUsageMetrics(
    config,
    event.model,
    event.cached_content_token_count,
    'cache',
  );
  recordTokenUsageMetrics(
    config,
    event.model,
    event.thoughts_token_count,
    'thought',
  );
  recordTokenUsageMetrics(config, event.model, event.tool_token_count, 'tool');
}

export function logLoopDetected(
  config: Config,
  event: LoopDetectedEvent,
): void {
  // ClearcutLogger.getInstance(config)?.logLoopDetectedEvent(event);
  if (!isTelemetrySdkInitialized()) return;

  const attributes: LogAttributes = {
    ...getCommonAttributes(config),
    ...event,
  };

  logWithSpan(
    'loop.detected',
    `Loop detected. Type: ${event.loop_type}.`,
    attributes,
  );
}
