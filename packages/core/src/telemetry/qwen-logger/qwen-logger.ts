/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Buffer } from 'buffer';
import * as https from 'https';
import * as os from 'node:os';
import { HttpsProxyAgent } from 'https-proxy-agent';

import type {
  StartSessionEvent,
  UserPromptEvent,
  ToolCallEvent,
  ApiRequestEvent,
  ApiResponseEvent,
  ApiErrorEvent,
  ApiCancelEvent,
  FileOperationEvent,
  FlashFallbackEvent,
  LoopDetectedEvent,
  NextSpeakerCheckEvent,
  SlashCommandEvent,
  MalformedJsonResponseEvent,
  IdeConnectionEvent,
  KittySequenceOverflowEvent,
  ChatCompressionEvent,
  InvalidChunkEvent,
  ContentRetryEvent,
  ContentRetryFailureEvent,
  ConversationFinishedEvent,
  SubagentExecutionEvent,
  ExtensionInstallEvent,
  ExtensionUninstallEvent,
  ToolOutputTruncatedEvent,
  ExtensionEnableEvent,
  ModelSlashCommandEvent,
  ExtensionDisableEvent,
  AuthEvent,
} from '../types.js';
import { EndSessionEvent } from '../types.js';
import type {
  RumEvent,
  RumViewEvent,
  RumActionEvent,
  RumResourceEvent,
  RumExceptionEvent,
  RumPayload,
  RumOS,
} from './event-types.js';
import type { Config } from '../../config/config.js';
import { safeJsonStringify } from '../../utils/safeJsonStringify.js';
import { InstallationManager } from '../../utils/installationManager.js';
import { FixedDeque } from 'mnemonist';
import { AuthType } from '../../core/contentGenerator.js';

// Usage statistics collection endpoint
const USAGE_STATS_HOSTNAME = 'gb4w8c3ygj-default-sea.rum.aliyuncs.com';
const USAGE_STATS_PATH = '/';

const RUN_APP_ID = 'gb4w8c3ygj@851d5d500f08f92';

/**
 * Interval in which buffered events are sent to RUM.
 */
const FLUSH_INTERVAL_MS = 1000 * 60;

/**
 * Maximum amount of events to keep in memory. Events added after this amount
 * are dropped until the next flush to RUM, which happens periodically as
 * defined by {@link FLUSH_INTERVAL_MS}.
 */
const MAX_EVENTS = 1000;

/**
 * Maximum events to retry after a failed RUM flush
 */
const MAX_RETRY_EVENTS = 100;

export interface LogResponse {
  nextRequestWaitMs?: number;
}

// Singleton class for batch posting log events to RUM. When a new event comes in, the elapsed time
// is checked and events are flushed to RUM if at least a minute has passed since the last flush.
export class QwenLogger {
  private static instance: QwenLogger;
  private config?: Config;
  private readonly installationManager: InstallationManager;

  /**
   * Queue of pending events that need to be flushed to the server. New events
   * are added to this queue and then flushed on demand (via `flushToRum`)
   */
  private readonly events: FixedDeque<RumEvent>;

  /**
   * The last time that the events were successfully flushed to the server.
   */
  private lastFlushTime: number = Date.now();

  private userId: string;
  private sessionId: string;

  /**
   * The value is true when there is a pending flush happening. This prevents
   * concurrent flush operations.
   */
  private isFlushInProgress: boolean = false;

  /**
   * This value is true when a flush was requested during an ongoing flush.
   */
  private pendingFlush: boolean = false;

  private isShutdown: boolean = false;

  private constructor(config?: Config) {
    this.config = config;
    this.events = new FixedDeque<RumEvent>(Array, MAX_EVENTS);
    this.installationManager = new InstallationManager();
    this.userId = this.generateUserId();
    this.sessionId =
      typeof this.config?.getSessionId === 'function'
        ? this.config.getSessionId()
        : '';
  }

  private generateUserId(): string {
    // Use InstallationManager to get installationId for userId
    const installationId = this.installationManager.getInstallationId();
    return `user-${installationId ?? 'unknown'}`;
  }

  static getInstance(config?: Config): QwenLogger | undefined {
    if (config === undefined || !config?.getUsageStatisticsEnabled())
      return undefined;
    if (!QwenLogger.instance) {
      QwenLogger.instance = new QwenLogger(config);
      process.on(
        'exit',
        QwenLogger.instance.shutdown.bind(QwenLogger.instance),
      );
    }

    return QwenLogger.instance;
  }

  enqueueLogEvent(event: RumEvent): void {
    try {
      // Manually handle overflow for FixedDeque, which throws when full.
      const wasAtCapacity = this.events.size >= MAX_EVENTS;

      if (wasAtCapacity) {
        this.events.shift(); // Evict oldest element to make space.
      }

      this.events.push(event);

      if (wasAtCapacity && this.config?.getDebugMode()) {
        console.debug(
          `QwenLogger: Dropped old event to prevent memory leak (queue size: ${this.events.size})`,
        );
      }
    } catch (error) {
      if (this.config?.getDebugMode()) {
        console.error('QwenLogger: Failed to enqueue log event.', error);
      }
    }
  }

  createRumEvent(
    eventType: 'view' | 'action' | 'exception' | 'resource',
    type: string,
    name: string,
    properties: Partial<RumEvent>,
  ): RumEvent {
    return {
      timestamp: Date.now(),
      event_type: eventType,
      type,
      name,
      ...(properties || {}),
    };
  }

  createViewEvent(
    type: string,
    name: string,
    properties: Partial<RumViewEvent>,
  ): RumEvent {
    return this.createRumEvent('view', type, name, properties);
  }

  createActionEvent(
    type: string,
    name: string,
    properties: Partial<RumActionEvent>,
  ): RumEvent {
    return this.createRumEvent('action', type, name, properties);
  }

  createResourceEvent(
    type: string,
    name: string,
    properties: Partial<RumResourceEvent>,
  ): RumEvent {
    return this.createRumEvent('resource', type, name, properties);
  }

  createExceptionEvent(
    type: string,
    name: string,
    properties: Partial<RumExceptionEvent>,
  ): RumEvent {
    return this.createRumEvent('exception', type, name, properties);
  }

  private getOsMetadata(): RumOS {
    return {
      type: os.platform(),
      version: os.release(),
    };
  }

  async createRumPayload(): Promise<RumPayload> {
    const authType = this.config?.getAuthType();
    const version = this.config?.getCliVersion() || 'unknown';
    const osMetadata = this.getOsMetadata();

    return {
      app: {
        id: RUN_APP_ID,
        env: process.env['DEBUG'] ? 'dev' : 'prod',
        version: version || 'unknown',
        type: 'cli',
      },
      user: {
        id: this.userId,
      },
      session: {
        id: this.sessionId,
      },
      view: {
        id: this.sessionId,
        name: 'qwen-code-cli',
      },
      os: osMetadata,

      events: this.events.toArray() as RumEvent[],
      properties: {
        auth_type: authType,
        model: this.config?.getModel(),
        base_url:
          authType === AuthType.USE_OPENAI
            ? this.config?.getContentGeneratorConfig().baseUrl || ''
            : '',
      },
      _v: `qwen-code@${version}`,
    };
  }

  flushIfNeeded(): void {
    if (Date.now() - this.lastFlushTime < FLUSH_INTERVAL_MS) {
      return;
    }

    this.flushToRum().catch((error) => {
      if (this.config?.getDebugMode()) {
        console.debug('Error flushing to RUM:', error);
      }
    });
  }

  async flushToRum(): Promise<LogResponse> {
    if (this.isFlushInProgress) {
      if (this.config?.getDebugMode()) {
        console.debug(
          'QwenLogger: Flush already in progress, marking pending flush.',
        );
      }
      this.pendingFlush = true;
      return Promise.resolve({});
    }
    this.isFlushInProgress = true;

    if (this.config?.getDebugMode()) {
      console.log('Flushing log events to RUM.');
    }
    if (this.events.size === 0) {
      this.isFlushInProgress = false;
      return {};
    }

    const eventsToSend = this.events.toArray() as RumEvent[];
    this.events.clear();

    const rumPayload = await this.createRumPayload();
    // Override events with the ones we're sending
    rumPayload.events = eventsToSend;
    try {
      await new Promise<Buffer>((resolve, reject) => {
        const body = safeJsonStringify(rumPayload);
        const options = {
          hostname: USAGE_STATS_HOSTNAME,
          path: USAGE_STATS_PATH,
          method: 'POST',
          headers: {
            'Content-Length': Buffer.byteLength(body),
            'Content-Type': 'text/plain;charset=UTF-8',
          },
        };
        const bufs: Buffer[] = [];
        const req = https.request(
          {
            ...options,
            agent: this.getProxyAgent(),
          },
          (res) => {
            if (
              res.statusCode &&
              (res.statusCode < 200 || res.statusCode >= 300)
            ) {
              const err = new Error(
                `Request failed with status ${res.statusCode}`,
              );
              res.resume();
              return reject(err);
            }
            res.on('data', (buf) => bufs.push(buf));
            res.on('end', () => resolve(Buffer.concat(bufs)));
          },
        );
        req.on('error', reject);
        req.end(body);
      });

      this.lastFlushTime = Date.now();
      return {};
    } catch (error) {
      if (this.config?.getDebugMode()) {
        console.error('RUM flush failed.', error);
      }

      // Re-queue failed events for retry
      this.requeueFailedEvents(eventsToSend);
      return {};
    } finally {
      this.isFlushInProgress = false;

      // If a flush was requested while we were flushing, flush again
      if (this.pendingFlush) {
        this.pendingFlush = false;
        // Fire and forget the pending flush
        this.flushToRum().catch((error) => {
          if (this.config?.getDebugMode()) {
            console.debug('Error in pending flush to RUM:', error);
          }
        });
      }
    }
  }

  // session events
  logStartSessionEvent(event: StartSessionEvent): void {
    const applicationEvent = this.createViewEvent('session', 'session_start', {
      properties: {
        model: event.model,
      },
      snapshots: JSON.stringify({
        embedding_model: event.embedding_model,
        sandbox_enabled: event.sandbox_enabled,
        core_tools_enabled: event.core_tools_enabled,
        approval_mode: event.approval_mode,
        api_key_enabled: event.api_key_enabled,
        vertex_ai_enabled: event.vertex_ai_enabled,
        debug_enabled: event.debug_enabled,
        mcp_servers: event.mcp_servers,
        telemetry_enabled: event.telemetry_enabled,
        telemetry_log_user_prompts_enabled:
          event.telemetry_log_user_prompts_enabled,
      }),
    });

    // Flush start event immediately
    this.enqueueLogEvent(applicationEvent);
    this.flushToRum().catch((error: unknown) => {
      if (this.config?.getDebugMode()) {
        console.debug('Error flushing to RUM:', error);
      }
    });
  }

  logEndSessionEvent(_event: EndSessionEvent): void {
    const applicationEvent = this.createViewEvent('session', 'session_end', {});

    // Flush immediately on session end.
    this.enqueueLogEvent(applicationEvent);
    this.flushToRum().catch((error: unknown) => {
      if (this.config?.getDebugMode()) {
        console.debug('Error flushing to RUM:', error);
      }
    });
  }

  logConversationFinishedEvent(event: ConversationFinishedEvent): void {
    const rumEvent = this.createActionEvent(
      'conversation',
      'conversation_finished',
      {
        snapshots: JSON.stringify({
          approval_mode: event.approvalMode,
          turn_count: event.turnCount,
        }),
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // user action events
  logNewPromptEvent(event: UserPromptEvent): void {
    const rumEvent = this.createActionEvent('user', 'new_prompt', {
      properties: {
        auth_type: event.auth_type,
        prompt_id: event.prompt_id,
      },
      snapshots: JSON.stringify({
        prompt_length: event.prompt_length,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logSlashCommandEvent(event: SlashCommandEvent): void {
    const rumEvent = this.createActionEvent('user', 'slash_command', {
      snapshots: JSON.stringify({
        command: event.command,
        subcommand: event.subcommand,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logModelSlashCommandEvent(event: ModelSlashCommandEvent): void {
    const rumEvent = this.createActionEvent('user', 'model_slash_command', {
      snapshots: JSON.stringify({
        model_name: event.model_name,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // tool call events
  logToolCallEvent(event: ToolCallEvent): void {
    const rumEvent = this.createActionEvent(
      'tool',
      `tool_call#${event.function_name}`,
      {
        properties: {
          prompt_id: event.prompt_id,
          response_id: event.response_id,
        },
        snapshots: JSON.stringify({
          function_name: event.function_name,
          decision: event.decision,
          success: event.success,
          duration_ms: event.duration_ms,
          error: event.error,
          error_type: event.error_type,
        }),
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logFileOperationEvent(event: FileOperationEvent): void {
    const rumEvent = this.createActionEvent(
      'tool',
      `file_operation#${event.tool_name}`,
      {
        snapshots: JSON.stringify({
          tool_name: event.tool_name,
          operation: event.operation,
          lines: event.lines,
          mimetype: event.mimetype,
          extension: event.extension,
          programming_language: event.programming_language,
        }),
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logSubagentExecutionEvent(event: SubagentExecutionEvent): void {
    const rumEvent = this.createActionEvent('tool', 'subagent_execution', {
      snapshots: JSON.stringify({
        subagent_name: event.subagent_name,
        status: event.status,
        terminate_reason: event.terminate_reason,
        execution_summary: event.execution_summary,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logToolOutputTruncatedEvent(event: ToolOutputTruncatedEvent): void {
    const rumEvent = this.createActionEvent('tool', 'tool_output_truncated', {
      snapshots: JSON.stringify({
        tool_name: event.tool_name,
        original_content_length: event.original_content_length,
        truncated_content_length: event.truncated_content_length,
        threshold: event.threshold,
        lines: event.lines,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // api events
  logApiRequestEvent(event: ApiRequestEvent): void {
    const rumEvent = this.createResourceEvent('api', 'api_request', {
      properties: {
        model: event.model,
        prompt_id: event.prompt_id,
      },
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logApiResponseEvent(event: ApiResponseEvent): void {
    const rumEvent = this.createResourceEvent('api', 'api_response', {
      status_code: event.status_code?.toString() ?? '',
      duration: event.duration_ms,
      success: 1,
      trace_id: event.response_id,
      properties: {
        auth_type: event.auth_type,
        model: event.model,
        prompt_id: event.prompt_id,
      },
      snapshots: JSON.stringify({
        input_token_count: event.input_token_count,
        output_token_count: event.output_token_count,
        cached_content_token_count: event.cached_content_token_count,
        thoughts_token_count: event.thoughts_token_count,
        tool_token_count: event.tool_token_count,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logApiCancelEvent(event: ApiCancelEvent): void {
    const rumEvent = this.createActionEvent('api', 'api_cancel', {
      properties: {
        model: event.model,
        prompt_id: event.prompt_id,
        auth_type: event.auth_type,
      },
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logApiErrorEvent(event: ApiErrorEvent): void {
    const rumEvent = this.createResourceEvent('api', 'api_error', {
      status_code: event.status_code?.toString() ?? '',
      duration: event.duration_ms,
      success: 0,
      message: event.error,
      trace_id: event.response_id,
      properties: {
        auth_type: event.auth_type,
        model: event.model,
        prompt_id: event.prompt_id,
      },
      snapshots: JSON.stringify({
        error_type: event.error_type,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // error events
  logInvalidChunkEvent(event: InvalidChunkEvent): void {
    const rumEvent = this.createExceptionEvent('error', 'invalid_chunk', {
      subtype: 'invalid_chunk',
      message: event.error_message,
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logContentRetryFailureEvent(event: ContentRetryFailureEvent): void {
    const rumEvent = this.createExceptionEvent(
      'error',
      'content_retry_failure',
      {
        subtype: 'content_retry_failure',
        message: `Content retry failed after ${event.total_attempts} attempts`,
        snapshots: JSON.stringify({
          total_attempts: event.total_attempts,
          final_error_type: event.final_error_type,
          total_duration_ms: event.total_duration_ms,
        }),
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logMalformedJsonResponseEvent(event: MalformedJsonResponseEvent): void {
    const rumEvent = this.createExceptionEvent(
      'error',
      'malformed_json_response',
      {
        subtype: 'malformed_json_response',
        properties: {
          model: event.model,
        },
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logLoopDetectedEvent(event: LoopDetectedEvent): void {
    const rumEvent = this.createExceptionEvent('error', 'loop_detected', {
      subtype: 'loop_detected',
      properties: {
        prompt_id: event.prompt_id,
      },
      snapshots: JSON.stringify({
        loop_type: event.loop_type,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logKittySequenceOverflowEvent(event: KittySequenceOverflowEvent): void {
    const rumEvent = this.createExceptionEvent(
      'overflow',
      'kitty_sequence_overflow',
      {
        subtype: 'kitty_sequence_overflow',
        snapshots: JSON.stringify({
          sequence_length: event.sequence_length,
          truncated_sequence: event.truncated_sequence,
        }),
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // ide events
  logIdeConnectionEvent(event: IdeConnectionEvent): void {
    const rumEvent = this.createActionEvent('ide', 'ide_connection', {
      snapshots: JSON.stringify({ connection_type: event.connection_type }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // extension events
  logExtensionInstallEvent(event: ExtensionInstallEvent): void {
    const rumEvent = this.createActionEvent('extension', 'extension_install', {
      snapshots: JSON.stringify({
        extension_name: event.extension_name,
        extension_version: event.extension_version,
        extension_source: event.extension_source,
        status: event.status,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logExtensionUninstallEvent(event: ExtensionUninstallEvent): void {
    const rumEvent = this.createActionEvent(
      'extension',
      'extension_uninstall',
      {
        snapshots: JSON.stringify({
          extension_name: event.extension_name,
          status: event.status,
        }),
      },
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logExtensionEnableEvent(event: ExtensionEnableEvent): void {
    const rumEvent = this.createActionEvent('extension', 'extension_enable', {
      snapshots: JSON.stringify({
        extension_name: event.extension_name,
        setting_scope: event.setting_scope,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logExtensionDisableEvent(event: ExtensionDisableEvent): void {
    const rumEvent = this.createActionEvent('extension', 'extension_disable', {
      snapshots: JSON.stringify({
        extension_name: event.extension_name,
        setting_scope: event.setting_scope,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logAuthEvent(event: AuthEvent): void {
    const snapshots: Record<string, unknown> = {
      auth_type: event.auth_type,
      action_type: event.action_type,
      status: event.status,
    };

    if (event.error_message) {
      snapshots['error_message'] = event.error_message;
    }

    const rumEvent = this.createActionEvent('auth', 'auth', {
      snapshots: JSON.stringify(snapshots),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  // misc events
  logFlashFallbackEvent(event: FlashFallbackEvent): void {
    const rumEvent = this.createActionEvent('misc', 'flash_fallback', {
      properties: {
        auth_type: event.auth_type,
      },
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logRipgrepFallbackEvent(): void {
    const rumEvent = this.createActionEvent('misc', 'ripgrep_fallback', {});

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logLoopDetectionDisabledEvent(): void {
    const rumEvent = this.createActionEvent(
      'misc',
      'loop_detection_disabled',
      {},
    );

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logNextSpeakerCheck(event: NextSpeakerCheckEvent): void {
    const rumEvent = this.createActionEvent('misc', 'next_speaker_check', {
      properties: {
        prompt_id: event.prompt_id,
      },
      snapshots: JSON.stringify({
        finish_reason: event.finish_reason,
        result: event.result,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logChatCompressionEvent(event: ChatCompressionEvent): void {
    const rumEvent = this.createActionEvent('misc', 'chat_compression', {
      snapshots: JSON.stringify({
        tokens_before: event.tokens_before,
        tokens_after: event.tokens_after,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  logContentRetryEvent(event: ContentRetryEvent): void {
    const rumEvent = this.createActionEvent('misc', 'content_retry', {
      snapshots: JSON.stringify({
        attempt_number: event.attempt_number,
        error_type: event.error_type,
        retry_delay_ms: event.retry_delay_ms,
      }),
    });

    this.enqueueLogEvent(rumEvent);
    this.flushIfNeeded();
  }

  getProxyAgent() {
    const proxyUrl = this.config?.getProxy();
    if (!proxyUrl) return undefined;
    // undici which is widely used in the repo can only support http & https proxy protocol,
    // https://github.com/nodejs/undici/issues/2224
    if (proxyUrl.startsWith('http')) {
      return new HttpsProxyAgent(proxyUrl);
    } else {
      throw new Error('Unsupported proxy type');
    }
  }

  shutdown() {
    if (this.isShutdown) return;

    this.isShutdown = true;
    const event = new EndSessionEvent(this.config);
    this.logEndSessionEvent(event);
  }

  private requeueFailedEvents(eventsToSend: RumEvent[]): void {
    // Add the events back to the front of the queue to be retried, but limit retry queue size
    const eventsToRetry = eventsToSend.slice(-MAX_RETRY_EVENTS); // Keep only the most recent events

    // Log a warning if we're dropping events
    if (eventsToSend.length > MAX_RETRY_EVENTS && this.config?.getDebugMode()) {
      console.warn(
        `QwenLogger: Dropping ${
          eventsToSend.length - MAX_RETRY_EVENTS
        } events due to retry queue limit. Total events: ${
          eventsToSend.length
        }, keeping: ${MAX_RETRY_EVENTS}`,
      );
    }

    // Determine how many events can be re-queued
    const availableSpace = MAX_EVENTS - this.events.size;
    const numEventsToRequeue = Math.min(eventsToRetry.length, availableSpace);

    if (numEventsToRequeue === 0) {
      if (this.config?.getDebugMode()) {
        console.debug(
          `QwenLogger: No events re-queued (queue size: ${this.events.size})`,
        );
      }
      return;
    }

    // Get the most recent events to re-queue
    const eventsToRequeue = eventsToRetry.slice(
      eventsToRetry.length - numEventsToRequeue,
    );

    // Prepend events to the front of the deque to be retried first.
    // We iterate backwards to maintain the original order of the failed events.
    for (let i = eventsToRequeue.length - 1; i >= 0; i--) {
      this.events.unshift(eventsToRequeue[i]);
    }
    // Clear any potential overflow
    while (this.events.size > MAX_EVENTS) {
      this.events.pop();
    }

    if (this.config?.getDebugMode()) {
      console.debug(
        `QwenLogger: Re-queued ${numEventsToRequeue} events for retry (queue size: ${this.events.size})`,
      );
    }
  }
}

export const TEST_ONLY = {
  MAX_RETRY_EVENTS,
  MAX_EVENTS,
  FLUSH_INTERVAL_MS,
};
