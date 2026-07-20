/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentHeadless — sequential task execution wrapper around AgentCore.
 *
 * AgentHeadless runs one headless task at a time while retaining its chat
 * session for follow-up tasks.
 * It delegates all model reasoning and tool scheduling to AgentCore.
 *
 * For persistent interactive agents, see AgentInteractive (Phase 2).
 */

import type { Content, FunctionDeclaration } from '@google/genai';
import type { Config } from '../../config/config.js';
import type { GeminiChat } from '../../core/geminiChat.js';
import type { RuntimeContentGeneratorView } from './agent-context.js';
import { createChildAbortController } from '../../utils/abortController.js';
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
  AgentExternalInput,
} from './agent-types.js';
import { AgentTerminateMode } from './agent-types.js';
import { logSubagentExecution } from '../../telemetry/loggers.js';
import { SubagentExecutionEvent } from '../../telemetry/types.js';
import { AgentCore, EXTERNAL_MESSAGE_PREFIX } from './agent-core.js';
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
  const placeholderRegex = /\$\{([a-zA-Z_]\w*)\}/g;

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
 * AgentHeadless — sequential task executor.
 *
 * Each execute() call runs one task through AgentCore's reasoning loop. Calls
 * must be sequential; later calls reuse the same chat and prepared tools.
 */
export class AgentHeadless {
  private readonly core: AgentCore;
  private finalText: string = '';
  private terminateMode: AgentTerminateMode = AgentTerminateMode.ERROR;
  private chat?: GeminiChat;
  private toolsList?: FunctionDeclaration[];
  private executing = false;
  private hasStartedReasoning = false;
  private externalMessageProvider?: () => AgentExternalInput[];
  private externalMessageWaiter?: (
    signal: AbortSignal,
  ) => Promise<AgentExternalInput[]>;
  private externalMessageWaitPredicate?: () => boolean;

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
    runtimeView?: RuntimeContentGeneratorView,
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
      runtimeView,
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
    options: {
      resetStats?: boolean;
      initialExternalInputs?: readonly AgentExternalInput[];
    } = {},
  ): Promise<void> {
    if (this.executing) {
      throw new Error(
        'AgentHeadless does not support concurrent execute() calls.',
      );
    }

    this.executing = true;
    this.finalText = '';
    this.terminateMode = AgentTerminateMode.ERROR;
    const resetStats = options.resetStats !== false;
    if (resetStats) {
      this.core.resetExecutionStats();
    }

    try {
      await this.executeTurn(
        context,
        externalSignal,
        !resetStats,
        options.initialExternalInputs,
      );
    } finally {
      this.executing = false;
    }
  }

  private async executeTurn(
    context: ContextState,
    externalSignal?: AbortSignal,
    preserveStats = false,
    initialExternalInputs?: readonly AgentExternalInput[],
  ): Promise<void> {
    const initialMessagesOverride = context.get('initial_messages_override') as
      | Content[]
      | undefined;
    const isContinuation = this.hasStartedReasoning;
    // Record the initial user turn in the observable message log before
    // anything that can throw — createChat / prepareTools failures still
    // get a transcript showing the task that was asked, which is what
    // the background-agent detail view reads via AgentCore.getMessages().
    // Mirrors AgentInteractive's run loop.
    const initialTaskText = String(
      (context.get('task_prompt') as string) ?? 'Get Started!',
    );
    const claimedExternalInputs =
      isContinuation && initialExternalInputs?.length
        ? initialExternalInputs
        : undefined;
    if (claimedExternalInputs) {
      for (const input of claimedExternalInputs) {
        this.core.eventEmitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
          subagentId: this.core.subagentId,
          kind: typeof input === 'string' ? 'message' : input.kind,
          text: typeof input === 'string' ? input : input.text,
          timestamp: Date.now(),
        });
      }
    } else if (isContinuation) {
      this.core.eventEmitter.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: this.core.subagentId,
        kind: 'message',
        text: initialTaskText,
        timestamp: Date.now(),
      });
    } else if (
      !initialMessagesOverride ||
      initialMessagesOverride.length === 0
    ) {
      this.core.pushMessage('user', initialTaskText);
    }

    let chat = this.chat;
    if (!chat) {
      chat = await this.core.createChat(context);
      this.chat = chat;
    }

    if (!chat) {
      this.terminateMode = AgentTerminateMode.ERROR;
      return;
    }

    // Child controller propagates from optional externalSignal and auto-cleans
    // its parent listener when aborted (see utils/abortController.ts).
    const abortController = createChildAbortController(externalSignal);

    try {
      if (!this.toolsList) {
        this.toolsList = await this.core.prepareTools();
      }
      const toolsList = this.toolsList;

      const initialMessages = isContinuation
        ? [
            {
              role: 'user' as const,
              parts: claimedExternalInputs
                ? claimedExternalInputs.map((input) => ({
                    text:
                      typeof input === 'string'
                        ? `${EXTERNAL_MESSAGE_PREFIX} ${input}`
                        : input.text,
                  }))
                : [{ text: `${EXTERNAL_MESSAGE_PREFIX} ${initialTaskText}` }],
            },
          ]
        : initialMessagesOverride && initialMessagesOverride.length > 0
          ? initialMessagesOverride
          : [{ role: 'user' as const, parts: [{ text: initialTaskText }] }];

      const startTime =
        preserveStats && this.core.executionStats.startTimeMs > 0
          ? this.core.executionStats.startTimeMs
          : Date.now();
      const roundOffset = preserveStats ? this.core.executionStats.rounds : 0;
      if (!preserveStats || this.core.executionStats.startTimeMs === 0) {
        this.core.executionStats.startTimeMs = startTime;
        this.core.stats.start(startTime);
      }

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
        const startEvent = new SubagentExecutionEvent(
          this.core.name,
          'started',
        );
        logSubagentExecution(this.core.runtimeContext, startEvent);

        // Delegate to AgentCore's reasoning loop
        this.hasStartedReasoning = true;
        const result = await this.core.runReasoningLoop(
          chat,
          initialMessages,
          toolsList,
          abortController,
          {
            maxTurns: this.core.runConfig.max_turns,
            maxTimeMinutes: this.core.runConfig.max_time_minutes,
            startTimeMs: startTime,
            roundOffset,
            getExternalMessages: this.externalMessageProvider,
            waitForExternalMessages: this.externalMessageWaiter,
            shouldWaitForExternalMessages: this.externalMessageWaitPredicate,
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
        this.core.executionStats.totalDurationMs =
          Date.now() - this.core.executionStats.startTimeMs;
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
          this.terminateMode === AgentTerminateMode.GOAL
            ? 'completed'
            : 'failed',
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
    } finally {
      // Outer finally guarantees the child's parent-signal listener is
      // detached even if prepareTools or initialMessages prep throws before
      // the inner try runs.
      abortController.abort();
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

  /**
   * Sets a callback that the reasoning loop calls between tool rounds
   * to drain external messages (e.g. from SendMessage tool).
   */
  setExternalMessageProvider(provider: () => AgentExternalInput[]): void {
    this.externalMessageProvider = provider;
  }

  setExternalMessageWaiter(
    waiter: (signal: AbortSignal) => Promise<AgentExternalInput[]>,
  ): void {
    this.externalMessageWaiter = waiter;
  }

  setExternalMessageWaitPredicate(predicate: () => boolean): void {
    this.externalMessageWaitPredicate = predicate;
  }

  get name(): string {
    return this.core.name;
  }

  get runtimeContext(): Config {
    return this.core.runtimeContext;
  }
}
