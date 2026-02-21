/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentHeadless — one-shot task execution wrapper around AgentCore.
 *
 * AgentHeadless manages
 * the lifecycle of a single headless task: start → run → finish.
 * It delegates all model reasoning and tool scheduling to AgentCore.
 *
 * For persistent interactive agents, see AgentInteractive (Phase 2).
 */

import type { Config } from '../../config/config.js';
import { createDebugLogger } from '../../utils/debugLogger.js';
import type {
  AgentEventEmitter,
  AgentStartEvent,
  AgentErrorEvent,
  AgentFinishEvent,
  AgentHooks,
} from './agent-events.js';
import { AgentEventType } from './agent-events.js';
import type { AgentStatsSummary } from './agent-statistics.js';
import type {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from './agent-types.js';
import { AgentTerminateMode } from './agent-types.js';
import { logSubagentExecution } from '../../telemetry/loggers.js';
import { SubagentExecutionEvent } from '../../telemetry/types.js';
import { AgentCore } from './agent-core.js';
import { DEFAULT_QWEN_MODEL } from '../../config/models.js';

const debugLogger = createDebugLogger('SUBAGENT');

// ─── Utilities (unchanged, re-exported for consumers) ────────

/**
 * Manages the runtime context state for the subagent.
 * This class provides a mechanism to store and retrieve key-value pairs
 * that represent the dynamic state and variables accessible to the subagent
 * during its execution.
 */
export class ContextState {
  private state: Record<string, unknown> = {};

  /**
   * Retrieves a value from the context state.
   *
   * @param key - The key of the value to retrieve.
   * @returns The value associated with the key, or undefined if the key is not found.
   */
  get(key: string): unknown {
    return this.state[key];
  }

  /**
   * Sets a value in the context state.
   *
   * @param key - The key to set the value under.
   * @param value - The value to set.
   */
  set(key: string, value: unknown): void {
    this.state[key] = value;
  }

  /**
   * Retrieves all keys in the context state.
   *
   * @returns An array of all keys in the context state.
   */
  get_keys(): string[] {
    return Object.keys(this.state);
  }
}

/**
 * Replaces `${...}` placeholders in a template string with values from a context.
 *
 * This function identifies all placeholders in the format `${key}`, validates that
 * each key exists in the provided `ContextState`, and then performs the substitution.
 *
 * @param template The template string containing placeholders.
 * @param context The `ContextState` object providing placeholder values.
 * @returns The populated string with all placeholders replaced.
 * @throws {Error} if any placeholder key is not found in the context.
 */
export function templateString(
  template: string,
  context: ContextState,
): string {
  const placeholderRegex = /\$\{(\w+)\}/g;

  // First, find all unique keys required by the template.
  const requiredKeys = new Set(
    Array.from(template.matchAll(placeholderRegex), (match) => match[1]),
  );

  // Check if all required keys exist in the context.
  const contextKeys = new Set(context.get_keys());
  const missingKeys = Array.from(requiredKeys).filter(
    (key) => !contextKeys.has(key),
  );

  if (missingKeys.length > 0) {
    throw new Error(
      `Missing context values for the following keys: ${missingKeys.join(
        ', ',
      )}`,
    );
  }

  // Perform the replacement using a replacer function.
  return template.replace(placeholderRegex, (_match, key) =>
    String(context.get(key)),
  );
}

// ─── AgentHeadless ──────────────────────────────────────────

/**
 * AgentHeadless — one-shot task executor.
 *
 * Takes a task, runs it through AgentCore's reasoning loop, and returns
 * the result.
 *
 * Lifecycle: Born → execute() → die.
 */
export class AgentHeadless {
  private readonly core: AgentCore;
  private finalText: string = '';
  private terminateMode: AgentTerminateMode = AgentTerminateMode.ERROR;

  private constructor(core: AgentCore) {
    this.core = core;
  }

  /**
   * Creates a new AgentHeadless instance.
   *
   * @param name - The name for the subagent, used for logging and identification.
   * @param runtimeContext - The shared runtime configuration and services.
   * @param promptConfig - Configuration for the subagent's prompt and behavior.
   * @param modelConfig - Configuration for the generative model parameters.
   * @param runConfig - Configuration for the subagent's execution environment.
   * @param toolConfig - Optional configuration for tools available to the subagent.
   * @param eventEmitter - Optional event emitter for streaming events to UI.
   * @param hooks - Optional lifecycle hooks.
   */
  static async create(
    name: string,
    runtimeContext: Config,
    promptConfig: PromptConfig,
    modelConfig: ModelConfig,
    runConfig: RunConfig,
    toolConfig?: ToolConfig,
    eventEmitter?: AgentEventEmitter,
    hooks?: AgentHooks,
  ): Promise<AgentHeadless> {
    const core = new AgentCore(
      name,
      runtimeContext,
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
      eventEmitter,
      hooks,
    );
    return new AgentHeadless(core);
  }

  /**
   * Executes the task in headless mode.
   *
   * This method orchestrates the subagent's execution lifecycle:
   * 1. Creates a chat session
   * 2. Prepares tools
   * 3. Runs the reasoning loop until completion/termination
   * 4. Emits start/finish/error events
   * 5. Records telemetry
   *
   * @param context - The current context state containing variables for prompt templating.
   * @param externalSignal - Optional abort signal for external cancellation.
   */
  async execute(
    context: ContextState,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const chat = await this.core.createChat(context);

    if (!chat) {
      this.terminateMode = AgentTerminateMode.ERROR;
      return;
    }

    // Set up abort signal propagation
    const abortController = new AbortController();
    const onExternalAbort = () => {
      abortController.abort();
    };
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort);
    }
    if (externalSignal?.aborted) {
      abortController.abort();
    }

    const toolsList = this.core.prepareTools();

    const initialTaskText = String(
      (context.get('task_prompt') as string) ?? 'Get Started!',
    );
    const initialMessages = [
      { role: 'user' as const, parts: [{ text: initialTaskText }] },
    ];

    const startTime = Date.now();
    this.core.executionStats.startTimeMs = startTime;
    this.core.stats.start(startTime);

    try {
      // Emit start event
      this.core.eventEmitter?.emit(AgentEventType.START, {
        subagentId: this.core.subagentId,
        name: this.core.name,
        model:
          this.core.modelConfig.model ||
          this.core.runtimeContext.getModel() ||
          DEFAULT_QWEN_MODEL,
        tools: (this.core.toolConfig?.tools || ['*']).map((t) =>
          typeof t === 'string' ? t : t.name,
        ),
        timestamp: Date.now(),
      } as AgentStartEvent);

      // Log telemetry for subagent start
      const startEvent = new SubagentExecutionEvent(this.core.name, 'started');
      logSubagentExecution(this.core.runtimeContext, startEvent);

      // Delegate to AgentCore's reasoning loop
      const result = await this.core.runReasoningLoop(
        chat,
        initialMessages,
        toolsList,
        abortController,
        {
          maxTurns: this.core.runConfig.max_turns,
          maxTimeMinutes: this.core.runConfig.max_time_minutes,
          startTimeMs: startTime,
        },
      );

      this.finalText = result.text;
      this.terminateMode = result.terminateMode ?? AgentTerminateMode.GOAL;
    } catch (error) {
      debugLogger.error('Error during subagent execution:', error);
      this.terminateMode = AgentTerminateMode.ERROR;
      this.core.eventEmitter?.emit(AgentEventType.ERROR, {
        subagentId: this.core.subagentId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      } as AgentErrorEvent);

      throw error;
    } finally {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      this.core.executionStats.totalDurationMs = Date.now() - startTime;
      const summary = this.core.stats.getSummary(Date.now());
      this.core.eventEmitter?.emit(AgentEventType.FINISH, {
        subagentId: this.core.subagentId,
        terminateReason: this.terminateMode,
        timestamp: Date.now(),
        rounds: summary.rounds,
        totalDurationMs: summary.totalDurationMs,
        totalToolCalls: summary.totalToolCalls,
        successfulToolCalls: summary.successfulToolCalls,
        failedToolCalls: summary.failedToolCalls,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        totalTokens: summary.totalTokens,
      } as AgentFinishEvent);

      const completionEvent = new SubagentExecutionEvent(
        this.core.name,
        this.terminateMode === AgentTerminateMode.GOAL ? 'completed' : 'failed',
        {
          terminate_reason: this.terminateMode,
          result: this.finalText,
          execution_summary: this.core.stats.formatCompact(
            'Subagent execution completed',
          ),
        },
      );
      logSubagentExecution(this.core.runtimeContext, completionEvent);

      await this.core.hooks?.onStop?.({
        subagentId: this.core.subagentId,
        name: this.core.name,
        terminateReason: this.terminateMode,
        summary: summary as unknown as Record<string, unknown>,
        timestamp: Date.now(),
      });
    }
  }

  // ─── Accessors ─────────────────────────────────────────────

  /**
   * Provides access to the underlying AgentCore for advanced use cases.
   * Used by AgentInteractive and InProcessBackend.
   */
  getCore(): AgentCore {
    return this.core;
  }

  get executionStats() {
    return this.core.executionStats;
  }

  set executionStats(value) {
    this.core.executionStats = value;
  }

  getEventEmitter() {
    return this.core.getEventEmitter();
  }

  getStatistics() {
    return this.core.getStatistics();
  }

  getExecutionSummary(): AgentStatsSummary {
    return this.core.getExecutionSummary();
  }

  getFinalText(): string {
    return this.finalText;
  }

  getTerminateMode(): AgentTerminateMode {
    return this.terminateMode;
  }

  get name(): string {
    return this.core.name;
  }

  get runtimeContext(): Config {
    return this.core.runtimeContext;
  }
}
