/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { reportError } from '../utils/errorReporting.js';
import type { Config } from '../config/config.js';
import { type ToolCallRequestInfo } from '../core/turn.js';
import {
  CoreToolScheduler,
  type ToolCall,
  type WaitingToolCall,
} from '../core/coreToolScheduler.js';
import type {
  ToolConfirmationOutcome,
  ToolCallConfirmationDetails,
} from '../tools/tools.js';
import { getInitialChatHistory } from '../utils/environmentContext.js';
import type {
  Content,
  Part,
  FunctionCall,
  GenerateContentConfig,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { GeminiChat } from '../core/geminiChat.js';
import type {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from './types.js';
import { SubagentTerminateMode } from './types.js';
import type {
  SubAgentFinishEvent,
  SubAgentRoundEvent,
  SubAgentStartEvent,
  SubAgentToolCallEvent,
  SubAgentToolResultEvent,
  SubAgentStreamTextEvent,
  SubAgentErrorEvent,
} from './subagent-events.js';
import {
  type SubAgentEventEmitter,
  SubAgentEventType,
} from './subagent-events.js';
import {
  SubagentStatistics,
  type SubagentStatsSummary,
} from './subagent-statistics.js';
import type { SubagentHooks } from './subagent-hooks.js';
import { logSubagentExecution } from '../telemetry/loggers.js';
import { SubagentExecutionEvent } from '../telemetry/types.js';
import { TaskTool } from '../tools/task.js';
import { DEFAULT_QWEN_MODEL } from '../config/models.js';

/**
 * @fileoverview Defines the configuration interfaces for a subagent.
 *
 * These interfaces specify the structure for defining the subagent's prompt,
 * the model parameters, and the execution settings.
 */

interface ExecutionStats {
  startTimeMs: number;
  totalDurationMs: number;
  rounds: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
}

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
function templateString(template: string, context: ContextState): string {
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

/**
 * Represents the scope and execution environment for a subagent.
 * This class orchestrates the subagent's lifecycle, managing its chat interactions,
 * runtime context, and the collection of its outputs.
 */
export class SubAgentScope {
  executionStats: ExecutionStats = {
    startTimeMs: 0,
    totalDurationMs: 0,
    rounds: 0,
    totalToolCalls: 0,
    successfulToolCalls: 0,
    failedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCost: 0,
  };
  private toolUsage = new Map<
    string,
    {
      count: number;
      success: number;
      failure: number;
      lastError?: string;
      totalDurationMs?: number;
      averageDurationMs?: number;
    }
  >();
  private eventEmitter?: SubAgentEventEmitter;
  private finalText: string = '';
  private terminateMode: SubagentTerminateMode = SubagentTerminateMode.ERROR;
  private readonly stats = new SubagentStatistics();
  private hooks?: SubagentHooks;
  private readonly subagentId: string;

  /**
   * Constructs a new SubAgentScope instance.
   * @param name - The name for the subagent, used for logging and identification.
   * @param runtimeContext - The shared runtime configuration and services.
   * @param promptConfig - Configuration for the subagent's prompt and behavior.
   * @param modelConfig - Configuration for the generative model parameters.
   * @param runConfig - Configuration for the subagent's execution environment.
   * @param toolConfig - Optional configuration for tools available to the subagent.
   */
  private constructor(
    readonly name: string,
    readonly runtimeContext: Config,
    private readonly promptConfig: PromptConfig,
    private readonly modelConfig: ModelConfig,
    private readonly runConfig: RunConfig,
    private readonly toolConfig?: ToolConfig,
    eventEmitter?: SubAgentEventEmitter,
    hooks?: SubagentHooks,
  ) {
    const randomPart = Math.random().toString(36).slice(2, 8);
    this.subagentId = `${this.name}-${randomPart}`;
    this.eventEmitter = eventEmitter;
    this.hooks = hooks;
  }

  /**
   * Creates and validates a new SubAgentScope instance.
   * This factory method ensures that all tools provided in the prompt configuration
   * are valid for non-interactive use before creating the subagent instance.
   * @param {string} name - The name of the subagent.
   * @param {Config} runtimeContext - The shared runtime configuration and services.
   * @param {PromptConfig} promptConfig - Configuration for the subagent's prompt and behavior.
   * @param {ModelConfig} modelConfig - Configuration for the generative model parameters.
   * @param {RunConfig} runConfig - Configuration for the subagent's execution environment.
   * @param {ToolConfig} [toolConfig] - Optional configuration for tools.
   * @returns {Promise<SubAgentScope>} A promise that resolves to a valid SubAgentScope instance.
   * @throws {Error} If any tool requires user confirmation.
   */
  static async create(
    name: string,
    runtimeContext: Config,
    promptConfig: PromptConfig,
    modelConfig: ModelConfig,
    runConfig: RunConfig,
    toolConfig?: ToolConfig,
    eventEmitter?: SubAgentEventEmitter,
    hooks?: SubagentHooks,
  ): Promise<SubAgentScope> {
    return new SubAgentScope(
      name,
      runtimeContext,
      promptConfig,
      modelConfig,
      runConfig,
      toolConfig,
      eventEmitter,
      hooks,
    );
  }

  /**
   * Runs the subagent in a non-interactive mode.
   * This method orchestrates the subagent's execution loop, including prompt templating,
   * tool execution, and termination conditions.
   * @param {ContextState} context - The current context state containing variables for prompt templating.
   * @returns {Promise<void>} A promise that resolves when the subagent has completed its execution.
   */
  async runNonInteractive(
    context: ContextState,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    const chat = await this.createChatObject(context);

    if (!chat) {
      this.terminateMode = SubagentTerminateMode.ERROR;
      return;
    }

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortController.abort();
        this.terminateMode = SubagentTerminateMode.CANCELLED;
        return;
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }
    const toolRegistry = this.runtimeContext.getToolRegistry();

    // Prepare the list of tools available to the subagent.
    // If no explicit toolConfig or it contains "*" or is empty, inherit all tools.
    const toolsList: FunctionDeclaration[] = [];
    if (this.toolConfig) {
      const asStrings = this.toolConfig.tools.filter(
        (t): t is string => typeof t === 'string',
      );
      const hasWildcard = asStrings.includes('*');
      const onlyInlineDecls = this.toolConfig.tools.filter(
        (t): t is FunctionDeclaration => typeof t !== 'string',
      );

      if (hasWildcard || asStrings.length === 0) {
        toolsList.push(
          ...toolRegistry
            .getFunctionDeclarations()
            .filter((t) => t.name !== TaskTool.Name),
        );
      } else {
        toolsList.push(
          ...toolRegistry.getFunctionDeclarationsFiltered(asStrings),
        );
      }
      toolsList.push(...onlyInlineDecls);
    } else {
      // Inherit all available tools by default when not specified.
      toolsList.push(
        ...toolRegistry
          .getFunctionDeclarations()
          .filter((t) => t.name !== TaskTool.Name),
      );
    }

    const initialTaskText = String(
      (context.get('task_prompt') as string) ?? 'Get Started!',
    );
    let currentMessages: Content[] = [
      { role: 'user', parts: [{ text: initialTaskText }] },
    ];

    const startTime = Date.now();
    this.executionStats.startTimeMs = startTime;
    this.stats.start(startTime);
    let turnCounter = 0;
    try {
      // Emit start event
      this.eventEmitter?.emit(SubAgentEventType.START, {
        subagentId: this.subagentId,
        name: this.name,
        model:
          this.modelConfig.model ||
          this.runtimeContext.getModel() ||
          DEFAULT_QWEN_MODEL,
        tools: (this.toolConfig?.tools || ['*']).map((t) =>
          typeof t === 'string' ? t : t.name,
        ),
        timestamp: Date.now(),
      } as SubAgentStartEvent);

      // Log telemetry for subagent start
      const startEvent = new SubagentExecutionEvent(this.name, 'started');
      logSubagentExecution(this.runtimeContext, startEvent);
      while (true) {
        // Check termination conditions.
        if (
          this.runConfig.max_turns &&
          turnCounter >= this.runConfig.max_turns
        ) {
          this.terminateMode = SubagentTerminateMode.MAX_TURNS;
          break;
        }
        let durationMin = (Date.now() - startTime) / (1000 * 60);
        if (
          this.runConfig.max_time_minutes &&
          durationMin >= this.runConfig.max_time_minutes
        ) {
          this.terminateMode = SubagentTerminateMode.TIMEOUT;
          break;
        }

        const promptId = `${this.runtimeContext.getSessionId()}#${this.subagentId}#${turnCounter++}`;
        const messageParams = {
          message: currentMessages[0]?.parts || [],
          config: {
            abortSignal: abortController.signal,
            tools: [{ functionDeclarations: toolsList }],
          },
        };

        const responseStream = await chat.sendMessageStream(
          this.modelConfig.model ||
            this.runtimeContext.getModel() ||
            DEFAULT_QWEN_MODEL,
          messageParams,
          promptId,
        );
        this.eventEmitter?.emit(SubAgentEventType.ROUND_START, {
          subagentId: this.subagentId,
          round: turnCounter,
          promptId,
          timestamp: Date.now(),
        } as SubAgentRoundEvent);

        const functionCalls: FunctionCall[] = [];
        let roundText = '';
        let lastUsage: GenerateContentResponseUsageMetadata | undefined =
          undefined;
        let currentResponseId: string | undefined = undefined;
        for await (const streamEvent of responseStream) {
          if (abortController.signal.aborted) {
            this.terminateMode = SubagentTerminateMode.CANCELLED;
            return;
          }

          // Handle retry events
          if (streamEvent.type === 'retry') {
            continue;
          }

          // Handle chunk events
          if (streamEvent.type === 'chunk') {
            const resp = streamEvent.value;
            // Track the response ID for tool call correlation
            if (resp.responseId) {
              currentResponseId = resp.responseId;
            }
            if (resp.functionCalls) functionCalls.push(...resp.functionCalls);
            const content = resp.candidates?.[0]?.content;
            const parts = content?.parts || [];
            for (const p of parts) {
              const txt = (p as Part & { text?: string }).text;
              if (txt) roundText += txt;
              if (txt)
                this.eventEmitter?.emit(SubAgentEventType.STREAM_TEXT, {
                  subagentId: this.subagentId,
                  round: turnCounter,
                  text: txt,
                  timestamp: Date.now(),
                } as SubAgentStreamTextEvent);
            }
            if (resp.usageMetadata) lastUsage = resp.usageMetadata;
          }
        }
        this.executionStats.rounds = turnCounter;
        this.stats.setRounds(turnCounter);

        durationMin = (Date.now() - startTime) / (1000 * 60);
        if (
          this.runConfig.max_time_minutes &&
          durationMin >= this.runConfig.max_time_minutes
        ) {
          this.terminateMode = SubagentTerminateMode.TIMEOUT;
          break;
        }

        // Update token usage if available
        if (lastUsage) {
          const inTok = Number(lastUsage.promptTokenCount || 0);
          const outTok = Number(lastUsage.candidatesTokenCount || 0);
          if (isFinite(inTok) || isFinite(outTok)) {
            this.stats.recordTokens(
              isFinite(inTok) ? inTok : 0,
              isFinite(outTok) ? outTok : 0,
            );
            // mirror legacy fields for compatibility
            this.executionStats.inputTokens =
              (this.executionStats.inputTokens || 0) +
              (isFinite(inTok) ? inTok : 0);
            this.executionStats.outputTokens =
              (this.executionStats.outputTokens || 0) +
              (isFinite(outTok) ? outTok : 0);
            this.executionStats.totalTokens =
              (this.executionStats.inputTokens || 0) +
              (this.executionStats.outputTokens || 0);
            this.executionStats.estimatedCost =
              (this.executionStats.inputTokens || 0) * 3e-5 +
              (this.executionStats.outputTokens || 0) * 6e-5;
          }
        }

        if (functionCalls.length > 0) {
          currentMessages = await this.processFunctionCalls(
            functionCalls,
            abortController,
            promptId,
            turnCounter,
            currentResponseId,
          );
        } else {
          // No tool calls — treat this as the model's final answer.
          if (roundText && roundText.trim().length > 0) {
            this.finalText = roundText.trim();
            this.terminateMode = SubagentTerminateMode.GOAL;
            break;
          }
          // Otherwise, nudge the model to finalize a result.
          currentMessages = [
            {
              role: 'user',
              parts: [
                {
                  text: 'Please provide the final result now and stop calling tools.',
                },
              ],
            },
          ];
        }
        this.eventEmitter?.emit(SubAgentEventType.ROUND_END, {
          subagentId: this.subagentId,
          round: turnCounter,
          promptId,
          timestamp: Date.now(),
        } as SubAgentRoundEvent);
      }
    } catch (error) {
      console.error('Error during subagent execution:', error);
      this.terminateMode = SubagentTerminateMode.ERROR;
      this.eventEmitter?.emit(SubAgentEventType.ERROR, {
        subagentId: this.subagentId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      } as SubAgentErrorEvent);

      throw error;
    } finally {
      if (externalSignal) externalSignal.removeEventListener('abort', onAbort);
      this.executionStats.totalDurationMs = Date.now() - startTime;
      const summary = this.stats.getSummary(Date.now());
      this.eventEmitter?.emit(SubAgentEventType.FINISH, {
        subagentId: this.subagentId,
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
      } as SubAgentFinishEvent);

      const completionEvent = new SubagentExecutionEvent(
        this.name,
        this.terminateMode === SubagentTerminateMode.GOAL
          ? 'completed'
          : 'failed',
        {
          terminate_reason: this.terminateMode,
          result: this.finalText,
          execution_summary: this.stats.formatCompact(
            'Subagent execution completed',
          ),
        },
      );
      logSubagentExecution(this.runtimeContext, completionEvent);

      await this.hooks?.onStop?.({
        subagentId: this.subagentId,
        name: this.name,
        terminateReason: this.terminateMode,
        summary: summary as unknown as Record<string, unknown>,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Processes a list of function calls, executing each one and collecting their responses.
   * This method iterates through the provided function calls, executes them using the
   * `executeToolCall` function (or handles `self.emitvalue` internally), and aggregates
   * their results. It also manages error reporting for failed tool executions.
   * @param {FunctionCall[]} functionCalls - An array of `FunctionCall` objects to process.
   * @param {ToolRegistry} toolRegistry - The tool registry to look up and execute tools.
   * @param {AbortController} abortController - An `AbortController` to signal cancellation of tool executions.
   * @param {string} responseId - Optional API response ID for correlation with tool calls.
   * @returns {Promise<Content[]>} A promise that resolves to an array of `Content` parts representing the tool responses,
   *          which are then used to update the chat history.
   */
  private async processFunctionCalls(
    functionCalls: FunctionCall[],
    abortController: AbortController,
    promptId: string,
    currentRound: number,
    responseId?: string,
  ): Promise<Content[]> {
    const toolResponseParts: Part[] = [];

    // Build scheduler
    const responded = new Set<string>();
    let resolveBatch: (() => void) | null = null;
    const scheduler = new CoreToolScheduler({
      outputUpdateHandler: undefined,
      onAllToolCallsComplete: async (completedCalls) => {
        for (const call of completedCalls) {
          const toolName = call.request.name;
          const duration = call.durationMs ?? 0;
          const success = call.status === 'success';
          const errorMessage =
            call.status === 'error' || call.status === 'cancelled'
              ? call.response.error?.message
              : undefined;

          // Update aggregate stats
          this.executionStats.totalToolCalls += 1;
          if (success) {
            this.executionStats.successfulToolCalls += 1;
          } else {
            this.executionStats.failedToolCalls += 1;
          }

          // Per-tool usage
          const tu = this.toolUsage.get(toolName) || {
            count: 0,
            success: 0,
            failure: 0,
            totalDurationMs: 0,
            averageDurationMs: 0,
          };
          tu.count += 1;
          if (success) {
            tu.success += 1;
          } else {
            tu.failure += 1;
            tu.lastError = errorMessage || 'Unknown error';
          }
          tu.totalDurationMs = (tu.totalDurationMs || 0) + duration;
          tu.averageDurationMs =
            tu.count > 0 ? tu.totalDurationMs / tu.count : 0;
          this.toolUsage.set(toolName, tu);

          // Emit tool result event
          this.eventEmitter?.emit(SubAgentEventType.TOOL_RESULT, {
            subagentId: this.subagentId,
            round: currentRound,
            callId: call.request.callId,
            name: toolName,
            success,
            error: errorMessage,
            responseParts: call.response.responseParts,
            /**
             * Tools like todoWrite will add some extra contents to the result,
             * making it unable to deserialize the `responseParts` to a JSON object.
             * While `resultDisplay` is normally a string, if not we stringify it,
             * so that we can deserialize it to a JSON object when needed.
             */
            resultDisplay: call.response.resultDisplay
              ? typeof call.response.resultDisplay === 'string'
                ? call.response.resultDisplay
                : JSON.stringify(call.response.resultDisplay)
              : undefined,
            durationMs: duration,
            timestamp: Date.now(),
          } as SubAgentToolResultEvent);

          // Update statistics service
          this.stats.recordToolCall(
            toolName,
            success,
            duration,
            this.toolUsage.get(toolName)?.lastError,
          );

          // post-tool hook
          await this.hooks?.postToolUse?.({
            subagentId: this.subagentId,
            name: this.name,
            toolName,
            args: call.request.args,
            success,
            durationMs: duration,
            errorMessage,
            timestamp: Date.now(),
          });

          // Append response parts
          const respParts = call.response.responseParts;
          if (respParts) {
            const parts = Array.isArray(respParts) ? respParts : [respParts];
            for (const part of parts) {
              if (typeof part === 'string') {
                toolResponseParts.push({ text: part });
              } else if (part) {
                toolResponseParts.push(part);
              }
            }
          }
        }
        // Signal that this batch is complete (all tools terminal)
        resolveBatch?.();
      },
      onToolCallsUpdate: (calls: ToolCall[]) => {
        for (const call of calls) {
          if (call.status !== 'awaiting_approval') continue;
          const waiting = call as WaitingToolCall;

          // Emit approval request event for UI visibility
          try {
            const { confirmationDetails } = waiting;
            const { onConfirm: _onConfirm, ...rest } = confirmationDetails;
            this.eventEmitter?.emit(SubAgentEventType.TOOL_WAITING_APPROVAL, {
              subagentId: this.subagentId,
              round: currentRound,
              callId: waiting.request.callId,
              name: waiting.request.name,
              description: this.getToolDescription(
                waiting.request.name,
                waiting.request.args,
              ),
              confirmationDetails: rest,
              respond: async (
                outcome: ToolConfirmationOutcome,
                payload?: Parameters<
                  ToolCallConfirmationDetails['onConfirm']
                >[1],
              ) => {
                if (responded.has(waiting.request.callId)) return;
                responded.add(waiting.request.callId);
                await waiting.confirmationDetails.onConfirm(outcome, payload);
              },
              timestamp: Date.now(),
            });
          } catch {
            // ignore UI event emission failures
          }

          // UI now renders inline confirmation via task tool live output.
        }
      },
      getPreferredEditor: () => undefined,
      config: this.runtimeContext,
      onEditorClose: () => {},
    });

    // Prepare requests and emit TOOL_CALL events
    const requests: ToolCallRequestInfo[] = functionCalls.map((fc) => {
      const toolName = String(fc.name || 'unknown');
      const callId = fc.id ?? `${fc.name}-${Date.now()}`;
      const args = (fc.args ?? {}) as Record<string, unknown>;
      const request: ToolCallRequestInfo = {
        callId,
        name: toolName,
        args,
        isClientInitiated: true,
        prompt_id: promptId,
        response_id: responseId,
      };

      const description = this.getToolDescription(toolName, args);
      this.eventEmitter?.emit(SubAgentEventType.TOOL_CALL, {
        subagentId: this.subagentId,
        round: currentRound,
        callId,
        name: toolName,
        args,
        description,
        timestamp: Date.now(),
      } as SubAgentToolCallEvent);

      // pre-tool hook
      void this.hooks?.preToolUse?.({
        subagentId: this.subagentId,
        name: this.name,
        toolName,
        args,
        timestamp: Date.now(),
      });

      return request;
    });

    if (requests.length > 0) {
      // Create a per-batch completion promise, resolve when onAllToolCallsComplete fires
      const batchDone = new Promise<void>((resolve) => {
        resolveBatch = () => {
          resolve();
          resolveBatch = null;
        };
      });
      await scheduler.schedule(requests, abortController.signal);
      await batchDone; // Wait for approvals + execution to finish
    }
    // If all tool calls failed, inform the model so it can re-evaluate.
    if (functionCalls.length > 0 && toolResponseParts.length === 0) {
      toolResponseParts.push({
        text: 'All tool calls failed. Please analyze the errors and try an alternative approach.',
      });
    }

    return [{ role: 'user', parts: toolResponseParts }];
  }

  getEventEmitter() {
    return this.eventEmitter;
  }

  getStatistics() {
    const total = this.executionStats.totalToolCalls;
    const successRate =
      total > 0 ? (this.executionStats.successfulToolCalls / total) * 100 : 0;
    return {
      ...this.executionStats,
      successRate,
      toolUsage: Array.from(this.toolUsage.entries()).map(([name, v]) => ({
        name,
        ...v,
      })),
    };
  }

  getExecutionSummary(): SubagentStatsSummary {
    return this.stats.getSummary();
  }

  getFinalText(): string {
    return this.finalText;
  }

  getTerminateMode(): SubagentTerminateMode {
    return this.terminateMode;
  }

  private async createChatObject(context: ContextState) {
    if (!this.promptConfig.systemPrompt && !this.promptConfig.initialMessages) {
      throw new Error(
        'PromptConfig must have either `systemPrompt` or `initialMessages` defined.',
      );
    }
    if (this.promptConfig.systemPrompt && this.promptConfig.initialMessages) {
      throw new Error(
        'PromptConfig cannot have both `systemPrompt` and `initialMessages` defined.',
      );
    }

    const envHistory = await getInitialChatHistory(this.runtimeContext);

    const start_history = [
      ...envHistory,
      ...(this.promptConfig.initialMessages ?? []),
    ];

    const systemInstruction = this.promptConfig.systemPrompt
      ? this.buildChatSystemPrompt(context)
      : undefined;

    try {
      const generationConfig: GenerateContentConfig & {
        systemInstruction?: string | Content;
      } = {
        temperature: this.modelConfig.temp,
        topP: this.modelConfig.top_p,
      };

      if (systemInstruction) {
        generationConfig.systemInstruction = systemInstruction;
      }

      return new GeminiChat(
        this.runtimeContext,
        generationConfig,
        start_history,
      );
    } catch (error) {
      await reportError(
        error,
        'Error initializing chat session.',
        start_history,
        'startChat',
      );
      // The calling function will handle the undefined return.
      return undefined;
    }
  }

  /**
   * Safely retrieves the description of a tool by attempting to build it.
   * Returns an empty string if any error occurs during the process.
   *
   * @param toolName The name of the tool to get description for.
   * @param args The arguments that would be passed to the tool.
   * @returns The tool description or empty string if error occurs.
   */
  private getToolDescription(
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    try {
      const toolRegistry = this.runtimeContext.getToolRegistry();
      const tool = toolRegistry.getTool(toolName);
      if (!tool) {
        return '';
      }

      const toolInstance = tool.build(args);
      return toolInstance.getDescription() || '';
    } catch {
      // Safely ignore all runtime errors and return empty string
      return '';
    }
  }

  private buildChatSystemPrompt(context: ContextState): string {
    if (!this.promptConfig.systemPrompt) {
      // This should ideally be caught in createChatObject, but serves as a safeguard.
      return '';
    }

    let finalPrompt = templateString(this.promptConfig.systemPrompt, context);

    // Add general non-interactive instructions.
    finalPrompt += `

Important Rules:
 - You operate in non-interactive mode: do not ask the user questions; proceed with available context.
 - Use tools only when necessary to obtain facts or make changes.
 - When the task is complete, return the final result as a normal model response (not a tool call) and stop.`;

    return finalPrompt;
  }
}
