/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  HookEventName,
  HookInput,
  HookOutput,
  HookExecutionResult,
  HookExecutionPlan,
} from './types.js';
import { createHookOutput } from './types.js';
import type { HookPlanner } from './planner.js';
import type { HookRegistry } from './registry.js';
import type { HookAggregationResult } from './aggregator.js';
import { HookAggregator } from './aggregator.js';
import type { HookRunner } from './runner.js';

/**
 * Message bus request for hook execution
 */
export interface HookExecutionMessageRequest {
  /** Request type identifier */
  type: 'HOOK_EXECUTION_REQUEST';
  /** Unique request ID */
  requestId: string;
  /** Event context */
  eventName: HookEventName;
  /** Session ID */
  sessionId: string;
  /** Current working directory */
  cwd: string;
  /** Transcript path */
  transcriptPath: string;
  /** Timestamp */
  timestamp: string;
  /** Event-specific input data */
  input: HookInput;
  /** Tool name (for tool events) */
  toolName?: string;
  /** Display name (for matching) */
  displayName?: string;
}

/**
 * Message bus response for hook execution
 */
export interface HookExecutionMessageResponse {
  /** Response type identifier */
  type: 'HOOK_EXECUTION_RESPONSE';
  /** Request ID this response corresponds to */
  requestId: string;
  /** Execution success */
  success: boolean;
  /** Aggregated output */
  output: HookOutput;
  /** Individual hook results */
  results: HookExecutionResult[];
  /** Whether execution was blocked */
  isBlocking: boolean;
  /** Reasons from hooks */
  reasons: string[];
  /** Execution duration in ms */
  duration: number;
  /** Error message if failed */
  error?: string;
}

/**
 * Telemetry event for hook execution
 */
export interface HookTelemetryEvent {
  /** Event type */
  type: 'HOOK_TELEMETRY';
  /** Request ID */
  requestId: string;
  /** Event name */
  eventName: HookEventName;
  /** Session ID */
  sessionId: string;
  /** Execution duration */
  duration: number;
  /** Number of hooks executed */
  hookCount: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Whether execution was blocked */
  isBlocking: boolean;
  /** Timestamp */
  timestamp: string;
}

/**
 * Message handler function type
 */
export type MessageHandler<TRequest, TResponse> = (
  request: TRequest,
) => Promise<TResponse>;

/**
 * Message bus interface for hook communication
 */
export interface HookMessageBus {
  /** Send a request and wait for response */
  request<TRequest, TResponse>(
    channel: string,
    payload: TRequest,
  ): Promise<TResponse>;
  /** Publish an event without waiting for response */
  publish<TEvent>(channel: string, event: TEvent): void;
}

/**
 * Options for MessageBusHookEventHandler
 */
export interface MessageBusHookEventHandlerOptions {
  /** Hook registry */
  registry: HookRegistry;
  /** Hook planner */
  planner: HookPlanner;
  /** Hook runner */
  runner: HookRunner;
  /** Message bus for communication */
  messageBus: HookMessageBus;
  /** Enable telemetry publishing */
  telemetry?: boolean;
  /** Channel names */
  channels?: {
    request?: string;
    response?: string;
    telemetry?: string;
  };
}

/**
 * MessageBusHookEventHandler integrates hooks with a message bus architecture.
 * It provides RPC-style communication for hook execution.
 *
 * Architecture:
 * - Subscribes to HOOK_EXECUTION_REQUEST messages
 * - Enriches input with base fields (session_id, cwd, timestamp)
 * - Coordinates: Planning → Execution → Aggregation → Telemetry
 * - Publishes HOOK_EXECUTION_RESPONSE messages
 */
export class MessageBusHookEventHandler {
  private requestChannel: string;
  private responseChannel: string;
  private telemetryChannel: string;

  constructor(private options: MessageBusHookEventHandlerOptions) {
    this.requestChannel = options.channels?.request ?? 'HOOK_EXECUTION_REQUEST';
    this.responseChannel =
      options.channels?.response ?? 'HOOK_EXECUTION_RESPONSE';
    this.telemetryChannel = options.channels?.telemetry ?? 'HOOK_TELEMETRY';
  }

  /**
   * Initialize the handler and start listening for messages
   */
  initialize(): void {
    // Subscribe to hook execution requests
    // Note: Actual subscription depends on message bus implementation
    // This sets up the handler to process requests
  }

  /**
   * Handle a hook execution request from the message bus
   * This is the main entry point for RPC-style hook execution
   */
  async handleRequest(
    request: HookExecutionMessageRequest,
  ): Promise<HookExecutionMessageResponse> {
    const startTime = Date.now();
    const requestId = request.requestId;

    try {
      // Step 1: Create execution plan using planner
      const plan = this.createExecutionPlan(request);

      // If no hooks to execute, return empty success
      if (plan.hookConfigs.length === 0) {
        const response: HookExecutionMessageResponse = {
          type: 'HOOK_EXECUTION_RESPONSE',
          requestId,
          success: true,
          output: createHookOutput(request.eventName, {}),
          results: [],
          isBlocking: false,
          reasons: [],
          duration: Date.now() - startTime,
        };
        return response;
      }

      // Step 2: Execute hooks (sequential or parallel)
      const results = await this.executeHooks(plan, request.input);

      // Step 3: Aggregate results
      const aggregationResult = this.aggregateResults(
        request.eventName,
        results,
      );

      const duration = Date.now() - startTime;

      // Step 4: Publish telemetry if enabled
      if (this.options.telemetry) {
        this.publishTelemetry(request, results, duration, requestId);
      }

      const response: HookExecutionMessageResponse = {
        type: 'HOOK_EXECUTION_RESPONSE',
        requestId,
        success: aggregationResult.success,
        output: aggregationResult.output,
        results: aggregationResult.individualResults,
        isBlocking: aggregationResult.isBlocking,
        reasons: aggregationResult.reasons,
        duration,
      };

      return response;
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error during hook execution';

      return {
        type: 'HOOK_EXECUTION_RESPONSE',
        requestId,
        success: false,
        output: createHookOutput(request.eventName, {}),
        results: [],
        isBlocking: true,
        reasons: [errorMessage],
        duration,
        error: errorMessage,
      };
    }
  }

  /**
   * Create execution plan for the request
   */
  private createExecutionPlan(
    request: HookExecutionMessageRequest,
  ): HookExecutionPlan {
    const { eventName, toolName, displayName } = request;

    return this.options.planner.createPlan({
      eventName,
      toolName: toolName ?? displayName,
      hookDefinitions: this.options.registry.getAllDefinitions(),
      deduplicate: true,
    });
  }

  /**
   * Execute hooks according to the plan
   */
  private async executeHooks(
    plan: HookExecutionPlan,
    input: HookInput,
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = [];

    if (plan.sequential) {
      // Sequential execution - hooks run one by one
      for (const hookConfig of plan.hookConfigs) {
        const result = await this.options.runner.run(
          hookConfig,
          input,
          plan.eventName,
        );
        results.push(result);

        // If a hook blocks, stop execution early
        if (this.isBlockingResult(result)) {
          break;
        }
      }
    } else {
      // Parallel execution - all hooks run concurrently
      const promises = plan.hookConfigs.map((hookConfig) =>
        this.options.runner.run(hookConfig, input, plan.eventName),
      );
      const parallelResults = await Promise.all(promises);
      results.push(...parallelResults);
    }

    return results;
  }

  /**
   * Check if a hook result indicates blocking
   */
  private isBlockingResult(result: HookExecutionResult): boolean {
    if (!result.output) return false;

    // Check top-level decision
    if (
      result.output.decision === 'block' ||
      result.output.decision === 'deny'
    ) {
      return true;
    }

    // Check hook-specific outputs
    const hookOutput = result.output;
    if (hookOutput.hookSpecificOutput) {
      // Check permissionDecision (PreToolUse style)
      if (
        'permissionDecision' in hookOutput.hookSpecificOutput &&
        (hookOutput.hookSpecificOutput['permissionDecision'] === 'deny' ||
          hookOutput.hookSpecificOutput['permissionDecision'] === 'block')
      ) {
        return true;
      }

      // Check decision.behavior (PermissionRequest style)
      if (
        'decision' in hookOutput.hookSpecificOutput &&
        typeof hookOutput.hookSpecificOutput['decision'] === 'object' &&
        hookOutput.hookSpecificOutput['decision'] !== null
      ) {
        const decision = hookOutput.hookSpecificOutput['decision'] as Record<
          string,
          unknown
        >;
        if (decision['behavior'] === 'deny') {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Aggregate hook execution results
   */
  private aggregateResults(
    eventName: HookEventName,
    results: HookExecutionResult[],
  ): HookAggregationResult {
    const aggregator = new HookAggregator(eventName);
    return aggregator.aggregate(results);
  }

  /**
   * Publish telemetry data to message bus
   */
  private publishTelemetry(
    request: HookExecutionMessageRequest,
    results: HookExecutionResult[],
    duration: number,
    requestId: string,
  ): void {
    const successfulHooks = results.filter((r) => r.success).length;
    const successRate =
      results.length > 0 ? successfulHooks / results.length : 1;
    const isBlocking = results.some((r) => this.isBlockingResult(r));

    const telemetryEvent: HookTelemetryEvent = {
      type: 'HOOK_TELEMETRY',
      requestId,
      eventName: request.eventName,
      sessionId: request.sessionId,
      duration,
      hookCount: results.length,
      successRate,
      isBlocking,
      timestamp: new Date().toISOString(),
    };

    this.options.messageBus.publish(this.telemetryChannel, telemetryEvent);
  }

  /**
   * Create a hook execution request for the message bus
   */
  createRequest(
    eventName: HookEventName,
    input: HookInput,
    options: {
      sessionId: string;
      cwd: string;
      transcriptPath: string;
      toolName?: string;
      displayName?: string;
    },
  ): HookExecutionMessageRequest {
    return {
      type: 'HOOK_EXECUTION_REQUEST',
      requestId: this.generateRequestId(),
      eventName,
      sessionId: options.sessionId,
      cwd: options.cwd,
      transcriptPath: options.transcriptPath,
      timestamp: new Date().toISOString(),
      input,
      toolName: options.toolName,
      displayName: options.displayName,
    };
  }

  /**
   * Send a hook execution request through the message bus
   */
  async sendRequest(
    request: HookExecutionMessageRequest,
  ): Promise<HookExecutionMessageResponse> {
    return this.options.messageBus.request(this.requestChannel, request);
  }

  /**
   * Generate a unique request ID
   */
  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Get handler statistics
   */
  getStats(): {
    requestChannel: string;
    responseChannel: string;
    telemetryChannel: string;
    telemetryEnabled: boolean;
  } {
    return {
      requestChannel: this.requestChannel,
      responseChannel: this.responseChannel,
      telemetryChannel: this.telemetryChannel,
      telemetryEnabled: this.options.telemetry ?? false,
    };
  }
}

/**
 * Create a message bus hook event handler
 */
export function createMessageBusHookEventHandler(
  options: MessageBusHookEventHandlerOptions,
): MessageBusHookEventHandler {
  return new MessageBusHookEventHandler(options);
}
