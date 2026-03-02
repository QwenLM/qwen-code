/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview AgentCore — the shared execution engine for subagents.
 *
 * AgentCore encapsulates the model reasoning loop, tool scheduling, stats,
 * and event emission. It is composed by both AgentHeadless (one-shot tasks)
 * and AgentInteractive (persistent interactive agents).
 *
 * AgentCore is stateless per-call: it does not own lifecycle or termination
 * logic. The caller (executor/collaborator) controls when to start, stop,
 * and how to interpret the results.
 */

import { reportError } from '../../utils/errorReporting.js';
import type { Config } from '../../config/config.js';
import { type ToolCallRequestInfo } from '../../core/turn.js';
import {
  CoreToolScheduler,
  type ToolCall,
  type ExecutingToolCall,
  type WaitingToolCall,
} from '../../core/coreToolScheduler.js';
import type {
  ToolConfirmationOutcome,
  ToolCallConfirmationDetails,
} from '../../tools/tools.js';
import { getInitialChatHistory } from '../../utils/environmentContext.js';
import type {
  Content,
  Part,
  FunctionCall,
  GenerateContentConfig,
  FunctionDeclaration,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { GeminiChat } from '../../core/geminiChat.js';
import type {
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from './agent-types.js';
import { AgentTerminateMode } from './agent-types.js';
import type {
  AgentRoundEvent,
  AgentRoundTextEvent,
  AgentToolCallEvent,
  AgentToolResultEvent,
  AgentToolOutputUpdateEvent,
  AgentUsageEvent,
  AgentHooks,
} from './agent-events.js';
import { type AgentEventEmitter, AgentEventType } from './agent-events.js';
import { AgentStatistics, type AgentStatsSummary } from './agent-statistics.js';
import { TaskTool } from '../../tools/task.js';
import { DEFAULT_QWEN_MODEL } from '../../config/models.js';
import { type ContextState, templateString } from './agent-headless.js';

/**
 * Result of a single reasoning loop invocation.
 */
export interface ReasoningLoopResult {
  /** The final model text response (empty if terminated by abort/limits). */
  text: string;
  /** Why the loop ended. null = normal text completion (no tool calls). */
  terminateMode: AgentTerminateMode | null;
  /** Number of model round-trips completed. */
  turnsUsed: number;
}

/**
 * Options for configuring a reasoning loop invocation.
 */
export interface ReasoningLoopOptions {
  /** Maximum number of turns before stopping. */
  maxTurns?: number;
  /** Maximum wall-clock time in minutes before stopping. */
  maxTimeMinutes?: number;
  /** Start time in ms (for timeout calculation). Defaults to Date.now(). */
  startTimeMs?: number;
}

/**
 * Options for chat creation.
 */
export interface CreateChatOptions {
  /**
   * When true, omits the "non-interactive mode" system prompt suffix.
   * Used by AgentInteractive for persistent interactive agents.
   */
  interactive?: boolean;
}

/**
 * Legacy execution stats maintained for backward compatibility.
 */
export interface ExecutionStats {
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
 * AgentCore — shared execution engine for model reasoning and tool scheduling.
 *
 * This class encapsulates:
 * - Chat/model session creation (`createChat`)
 * - Tool list preparation (`prepareTools`)
 * - The inner reasoning loop (`runReasoningLoop`)
 * - Tool call scheduling and execution (`processFunctionCalls`)
 * - Statistics tracking and event emission
 *
 * It does NOT manage lifecycle (start/stop/terminate), abort signals,
 * or final result interpretation — those are the caller's responsibility.
 */
export class AgentCore {
  readonly subagentId: string;
  readonly name: string;
  readonly runtimeContext: Config;
  readonly promptConfig: PromptConfig;
  readonly modelConfig: ModelConfig;
  readonly runConfig: RunConfig;
  readonly toolConfig?: ToolConfig;
  readonly eventEmitter?: AgentEventEmitter;
  readonly hooks?: AgentHooks;
  readonly stats = new AgentStatistics();

  /**
   * Legacy execution stats maintained for aggregate tracking.
   */
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

  constructor(
    name: string,
    runtimeContext: Config,
    promptConfig: PromptConfig,
    modelConfig: ModelConfig,
    runConfig: RunConfig,
    toolConfig?: ToolConfig,
    eventEmitter?: AgentEventEmitter,
    hooks?: AgentHooks,
  ) {
    const randomPart = Math.random().toString(36).slice(2, 8);
    this.subagentId = `${name}-${randomPart}`;
    this.name = name;
    this.runtimeContext = runtimeContext;
    this.promptConfig = promptConfig;
    this.modelConfig = modelConfig;
    this.runConfig = runConfig;
    this.toolConfig = toolConfig;
    this.eventEmitter = eventEmitter;
    this.hooks = hooks;
  }

  // ─── Chat Creation ────────────────────────────────────────

  /**
   * Creates a GeminiChat instance configured for this agent.
   *
   * @param context - Context state for template variable substitution.
   * @param options - Chat creation options.
   *   - `interactive`: When true, omits the "non-interactive mode" system prompt suffix.
   * @returns A configured GeminiChat, or undefined if initialization fails.
   */
  async createChat(
    context: ContextState,
    options?: CreateChatOptions,
  ): Promise<GeminiChat | undefined> {
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

    const startHistory = [
      ...envHistory,
      ...(this.promptConfig.initialMessages ?? []),
    ];

    const systemInstruction = this.promptConfig.systemPrompt
      ? this.buildChatSystemPrompt(context, options)
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
        startHistory,
      );
    } catch (error) {
      await reportError(
        error,
        'Error initializing chat session.',
        startHistory,
        'startChat',
      );
      return undefined;
    }
  }

  // ─── Tool Preparation ─────────────────────────────────────

  /**
   * Prepares the list of tools available to this agent.
   *
   * If no explicit toolConfig or it contains "*" or is empty,
   * inherits all tools (excluding TaskTool to prevent recursion).
   */
  prepareTools(): FunctionDeclaration[] {
    const toolRegistry = this.runtimeContext.getToolRegistry();
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

    return toolsList;
  }

  // ─── Reasoning Loop ───────────────────────────────────────

  /**
   * Runs the inner model reasoning loop.
   *
   * This is the core execution cycle:
   * send messages → stream response → collect tool calls → execute tools → repeat.
   *
   * The loop terminates when:
   * - The model produces a text response without tool calls (normal completion)
   * - maxTurns is reached
   * - maxTimeMinutes is exceeded
   * - The abortController signal fires
   *
   * @param chat - The GeminiChat session to use.
   * @param initialMessages - The first messages to send (e.g., user task prompt).
   * @param toolsList - Available tool declarations.
   * @param abortController - Controls cancellation of the current loop.
   * @param options - Optional limits (maxTurns, maxTimeMinutes).
   * @returns ReasoningLoopResult with the final text, terminate mode, and turns used.
   */
  async runReasoningLoop(
    chat: GeminiChat,
    initialMessages: Content[],
    toolsList: FunctionDeclaration[],
    abortController: AbortController,
    options?: ReasoningLoopOptions,
  ): Promise<ReasoningLoopResult> {
    const startTime = options?.startTimeMs ?? Date.now();
    let currentMessages = initialMessages;
    let turnCounter = 0;
    let finalText = '';
    let terminateMode: AgentTerminateMode | null = null;

    while (true) {
      // Check abort before starting a new round — prevents unnecessary API
      // calls after processFunctionCalls was unblocked by an abort signal.
      if (abortController.signal.aborted) {
        terminateMode = AgentTerminateMode.CANCELLED;
        break;
      }

      // Check termination conditions.
      if (options?.maxTurns && turnCounter >= options.maxTurns) {
        terminateMode = AgentTerminateMode.MAX_TURNS;
        break;
      }

      let durationMin = (Date.now() - startTime) / (1000 * 60);
      if (options?.maxTimeMinutes && durationMin >= options.maxTimeMinutes) {
        terminateMode = AgentTerminateMode.TIMEOUT;
        break;
      }

      // Create a new AbortController per round to avoid listener accumulation
      // in the model SDK. The parent abortController propagates abort to it.
      const roundAbortController = new AbortController();
      const onParentAbort = () => roundAbortController.abort();
      abortController.signal.addEventListener('abort', onParentAbort);
      if (abortController.signal.aborted) {
        roundAbortController.abort();
      }

      const promptId = `${this.runtimeContext.getSessionId()}#${this.subagentId}#${turnCounter++}`;

      const messageParams = {
        message: currentMessages[0]?.parts || [],
        config: {
          abortSignal: roundAbortController.signal,
          tools: [{ functionDeclarations: toolsList }],
        },
      };

      const roundStreamStart = Date.now();
      const responseStream = await chat.sendMessageStream(
        this.modelConfig.model ||
          this.runtimeContext.getModel() ||
          DEFAULT_QWEN_MODEL,
        messageParams,
        promptId,
      );
      this.eventEmitter?.emit(AgentEventType.ROUND_START, {
        subagentId: this.subagentId,
        round: turnCounter,
        promptId,
        timestamp: Date.now(),
      } as AgentRoundEvent);

      const functionCalls: FunctionCall[] = [];
      let roundText = '';
      let roundThoughtText = '';
      let lastUsage: GenerateContentResponseUsageMetadata | undefined =
        undefined;
      let currentResponseId: string | undefined = undefined;

      for await (const streamEvent of responseStream) {
        if (roundAbortController.signal.aborted) {
          abortController.signal.removeEventListener('abort', onParentAbort);
          return {
            text: finalText,
            terminateMode: AgentTerminateMode.CANCELLED,
            turnsUsed: turnCounter,
          };
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
            const txt = p.text;
            const isThought = p.thought ?? false;
            if (txt && isThought) roundThoughtText += txt;
            if (txt && !isThought) roundText += txt;
            if (txt)
              this.eventEmitter?.emit(AgentEventType.STREAM_TEXT, {
                subagentId: this.subagentId,
                round: turnCounter,
                text: txt,
                thought: isThought,
                timestamp: Date.now(),
              });
          }
          if (resp.usageMetadata) lastUsage = resp.usageMetadata;
        }
      }

      if (roundText || roundThoughtText) {
        this.eventEmitter?.emit(AgentEventType.ROUND_TEXT, {
          subagentId: this.subagentId,
          round: turnCounter,
          text: roundText,
          thoughtText: roundThoughtText,
          timestamp: Date.now(),
        } as AgentRoundTextEvent);
      }

      this.executionStats.rounds = turnCounter;
      this.stats.setRounds(turnCounter);

      durationMin = (Date.now() - startTime) / (1000 * 60);
      if (options?.maxTimeMinutes && durationMin >= options.maxTimeMinutes) {
        abortController.signal.removeEventListener('abort', onParentAbort);
        terminateMode = AgentTerminateMode.TIMEOUT;
        break;
      }

      // Update token usage if available
      if (lastUsage) {
        this.recordTokenUsage(lastUsage, turnCounter, roundStreamStart);
      }

      if (functionCalls.length > 0) {
        currentMessages = await this.processFunctionCalls(
          functionCalls,
          roundAbortController,
          promptId,
          turnCounter,
          toolsList,
          currentResponseId,
        );
      } else {
        // No tool calls — treat this as the model's final answer.
        if (roundText && roundText.trim().length > 0) {
          finalText = roundText.trim();
          // Emit ROUND_END for the final round so all consumers see it.
          // Previously this was skipped, requiring AgentInteractive to
          // compensate with an explicit flushStreamBuffers() call.
          this.eventEmitter?.emit(AgentEventType.ROUND_END, {
            subagentId: this.subagentId,
            round: turnCounter,
            promptId,
            timestamp: Date.now(),
          } as AgentRoundEvent);
          // Clean up before breaking
          abortController.signal.removeEventListener('abort', onParentAbort);
          // null terminateMode = normal text completion
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

      this.eventEmitter?.emit(AgentEventType.ROUND_END, {
        subagentId: this.subagentId,
        round: turnCounter,
        promptId,
        timestamp: Date.now(),
      } as AgentRoundEvent);

      // Clean up the per-round listener before the next iteration
      abortController.signal.removeEventListener('abort', onParentAbort);
    }

    return {
      text: finalText,
      terminateMode,
      turnsUsed: turnCounter,
    };
  }

  // ─── Tool Execution ───────────────────────────────────────

  /**
   * Processes a list of function calls via CoreToolScheduler.
   *
   * Validates each call against the allowed tools list, schedules authorized
   * calls, collects results, and emits events for each call/result.
   *
   * Validates each call, schedules authorized calls, collects results, and emits events.
   */
  async processFunctionCalls(
    functionCalls: FunctionCall[],
    abortController: AbortController,
    promptId: string,
    currentRound: number,
    toolsList: FunctionDeclaration[],
    responseId?: string,
  ): Promise<Content[]> {
    const toolResponseParts: Part[] = [];

    // Build allowed tool names set for filtering
    const allowedToolNames = new Set(toolsList.map((t) => t.name));

    // Filter unauthorized tool calls before scheduling
    const authorizedCalls: FunctionCall[] = [];
    for (const fc of functionCalls) {
      const callId = fc.id ?? `${fc.name}-${Date.now()}`;

      if (!allowedToolNames.has(fc.name)) {
        const toolName = String(fc.name);
        const errorMessage = `Tool "${toolName}" not found. Tools must use the exact names provided.`;

        // Emit TOOL_CALL event for visibility
        this.eventEmitter?.emit(AgentEventType.TOOL_CALL, {
          subagentId: this.subagentId,
          round: currentRound,
          callId,
          name: toolName,
          args: fc.args ?? {},
          description: `Tool "${toolName}" not found`,
          isOutputMarkdown: false,
          timestamp: Date.now(),
        } as AgentToolCallEvent);

        // Build function response part (used for both event and LLM)
        const functionResponsePart = {
          functionResponse: {
            id: callId,
            name: toolName,
            response: { error: errorMessage },
          },
        };

        // Emit TOOL_RESULT event with error
        this.eventEmitter?.emit(AgentEventType.TOOL_RESULT, {
          subagentId: this.subagentId,
          round: currentRound,
          callId,
          name: toolName,
          success: false,
          error: errorMessage,
          responseParts: [functionResponsePart],
          resultDisplay: errorMessage,
          durationMs: 0,
          timestamp: Date.now(),
        } as AgentToolResultEvent);

        // Record blocked tool call in stats
        this.recordToolCallStats(toolName, false, 0, errorMessage);

        // Add function response for LLM
        toolResponseParts.push(functionResponsePart);
        continue;
      }
      authorizedCalls.push(fc);
    }

    // Build scheduler
    const responded = new Set<string>();
    let resolveBatch: (() => void) | null = null;
    const emittedCallIds = new Set<string>();
    // pidMap: callId → PTY PID, populated by onToolCallsUpdate when a shell
    // tool spawns a PTY. Shared with outputUpdateHandler via closure so the
    // PID is included in TOOL_OUTPUT_UPDATE events for interactive shell support.
    const pidMap = new Map<string, number>();
    const scheduler = new CoreToolScheduler({
      config: this.runtimeContext,
      outputUpdateHandler: (callId, outputChunk) => {
        this.eventEmitter?.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
          subagentId: this.subagentId,
          round: currentRound,
          callId,
          outputChunk,
          pid: pidMap.get(callId),
          timestamp: Date.now(),
        } as AgentToolOutputUpdateEvent);
      },
      onAllToolCallsComplete: async (completedCalls) => {
        for (const call of completedCalls) {
          if (emittedCallIds.has(call.request.callId)) continue;
          emittedCallIds.add(call.request.callId);

          const toolName = call.request.name;
          const duration = call.durationMs ?? 0;
          const success = call.status === 'success';
          const errorMessage =
            call.status === 'error' || call.status === 'cancelled'
              ? call.response.error?.message
              : undefined;

          // Record stats
          this.recordToolCallStats(toolName, success, duration, errorMessage);

          // Emit tool result event
          this.eventEmitter?.emit(AgentEventType.TOOL_RESULT, {
            subagentId: this.subagentId,
            round: currentRound,
            callId: call.request.callId,
            name: toolName,
            success,
            error: errorMessage,
            responseParts: call.response.responseParts,
            resultDisplay: call.response.resultDisplay,
            outputFile: call.response.outputFile,
            durationMs: duration,
            timestamp: Date.now(),
          } as AgentToolResultEvent);

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
          // Track PTY PIDs so TOOL_OUTPUT_UPDATE events can carry them.
          if (call.status === 'executing') {
            const pid = (call as ExecutingToolCall).pid;
            if (pid !== undefined) {
              const isNewPid = !pidMap.has(call.request.callId);
              pidMap.set(call.request.callId, pid);
              // Emit immediately so the UI can offer interactive shell
              // focus (Ctrl+F) before the tool produces its first output.
              if (isNewPid) {
                this.eventEmitter?.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
                  subagentId: this.subagentId,
                  round: currentRound,
                  callId: call.request.callId,
                  outputChunk: (call as ExecutingToolCall).liveOutput ?? '',
                  pid,
                  timestamp: Date.now(),
                } as AgentToolOutputUpdateEvent);
              }
            }
          }

          if (call.status !== 'awaiting_approval') continue;
          const waiting = call as WaitingToolCall;

          // Emit approval request event for UI visibility
          try {
            const { confirmationDetails } = waiting;
            const { onConfirm: _onConfirm, ...rest } = confirmationDetails;
            this.eventEmitter?.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
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
        }
      },
      getPreferredEditor: () => undefined,
      onEditorClose: () => {},
    });

    // Prepare requests and emit TOOL_CALL events
    const requests: ToolCallRequestInfo[] = authorizedCalls.map((fc) => {
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
      const isOutputMarkdown = this.getToolIsOutputMarkdown(toolName);
      this.eventEmitter?.emit(AgentEventType.TOOL_CALL, {
        subagentId: this.subagentId,
        round: currentRound,
        callId,
        name: toolName,
        args,
        description,
        isOutputMarkdown,
        timestamp: Date.now(),
      } as AgentToolCallEvent);

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
      // Create a per-batch completion promise
      const batchDone = new Promise<void>((resolve) => {
        resolveBatch = () => {
          resolve();
          resolveBatch = null;
        };
      });

      // Auto-resolve on abort so processFunctionCalls doesn't block forever
      // when tools are awaiting approval or executing without abort support.
      const onAbort = () => {
        resolveBatch?.();
        for (const req of requests) {
          if (emittedCallIds.has(req.callId)) continue;
          emittedCallIds.add(req.callId);

          const errorMessage = 'Tool call cancelled by user abort.';
          this.recordToolCallStats(req.name, false, 0, errorMessage);

          this.eventEmitter?.emit(AgentEventType.TOOL_RESULT, {
            subagentId: this.subagentId,
            round: currentRound,
            callId: req.callId,
            name: req.name,
            success: false,
            error: errorMessage,
            responseParts: [
              {
                functionResponse: {
                  id: req.callId,
                  name: req.name,
                  response: { error: errorMessage },
                },
              },
            ],
            resultDisplay: errorMessage,
            durationMs: 0,
            timestamp: Date.now(),
          } as AgentToolResultEvent);
        }
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });

      // If already aborted before the listener was registered, resolve
      // immediately to avoid blocking forever.
      if (abortController.signal.aborted) {
        onAbort();
      }

      await scheduler.schedule(requests, abortController.signal);
      await batchDone;

      abortController.signal.removeEventListener('abort', onAbort);
    }

    // If all tool calls failed, inform the model so it can re-evaluate.
    if (functionCalls.length > 0 && toolResponseParts.length === 0) {
      toolResponseParts.push({
        text: 'All tool calls failed. Please analyze the errors and try an alternative approach.',
      });
    }

    return [{ role: 'user', parts: toolResponseParts }];
  }

  // ─── Stats & Events ───────────────────────────────────────

  getEventEmitter(): AgentEventEmitter | undefined {
    return this.eventEmitter;
  }

  getExecutionSummary(): AgentStatsSummary {
    return this.stats.getSummary();
  }

  /**
   * Returns legacy execution statistics and per-tool usage.
   * Returns legacy execution statistics and per-tool usage.
   */
  getStatistics(): {
    successRate: number;
    toolUsage: Array<{
      name: string;
      count: number;
      success: number;
      failure: number;
      lastError?: string;
      totalDurationMs?: number;
      averageDurationMs?: number;
    }>;
  } & ExecutionStats {
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

  /**
   * Safely retrieves the description of a tool by attempting to build it.
   * Returns an empty string if any error occurs during the process.
   */
  getToolDescription(toolName: string, args: Record<string, unknown>): string {
    try {
      const toolRegistry = this.runtimeContext.getToolRegistry();
      const tool = toolRegistry.getTool(toolName);
      if (!tool) {
        return '';
      }

      const toolInstance = tool.build(args);
      return toolInstance.getDescription() || '';
    } catch {
      return '';
    }
  }

  private getToolIsOutputMarkdown(toolName: string): boolean {
    try {
      const toolRegistry = this.runtimeContext.getToolRegistry();
      return toolRegistry.getTool(toolName)?.isOutputMarkdown ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Records tool call statistics for both successful and failed tool calls.
   */
  recordToolCallStats(
    toolName: string,
    success: boolean,
    durationMs: number,
    errorMessage?: string,
  ): void {
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
    tu.totalDurationMs = (tu.totalDurationMs || 0) + durationMs;
    tu.averageDurationMs = tu.count > 0 ? tu.totalDurationMs / tu.count : 0;
    this.toolUsage.set(toolName, tu);

    // Update statistics service
    this.stats.recordToolCall(
      toolName,
      success,
      durationMs,
      this.toolUsage.get(toolName)?.lastError,
    );
  }

  // ─── Private Helpers ──────────────────────────────────────

  /**
   * Builds the system prompt with template substitution and optional
   * non-interactive instructions suffix.
   */
  private buildChatSystemPrompt(
    context: ContextState,
    options?: CreateChatOptions,
  ): string {
    if (!this.promptConfig.systemPrompt) {
      return '';
    }

    let finalPrompt = templateString(this.promptConfig.systemPrompt, context);

    // Only add non-interactive instructions when NOT in interactive mode
    if (!options?.interactive) {
      finalPrompt += `

Important Rules:
 - You operate in non-interactive mode: do not ask the user questions; proceed with available context.
 - Use tools only when necessary to obtain facts or make changes.
 - When the task is complete, return the final result as a normal model response (not a tool call) and stop.`;
    }

    return finalPrompt;
  }

  /**
   * Records token usage from model response metadata.
   */
  private recordTokenUsage(
    usage: GenerateContentResponseUsageMetadata,
    turnCounter: number,
    roundStreamStart: number,
  ): void {
    const inTok = Number(usage.promptTokenCount || 0);
    const outTok = Number(usage.candidatesTokenCount || 0);
    const thoughtTok = Number(usage.thoughtsTokenCount || 0);
    const cachedTok = Number(usage.cachedContentTokenCount || 0);
    if (
      isFinite(inTok) ||
      isFinite(outTok) ||
      isFinite(thoughtTok) ||
      isFinite(cachedTok)
    ) {
      this.stats.recordTokens(
        isFinite(inTok) ? inTok : 0,
        isFinite(outTok) ? outTok : 0,
        isFinite(thoughtTok) ? thoughtTok : 0,
        isFinite(cachedTok) ? cachedTok : 0,
      );
      // Mirror legacy fields for compatibility
      this.executionStats.inputTokens =
        (this.executionStats.inputTokens || 0) + (isFinite(inTok) ? inTok : 0);
      this.executionStats.outputTokens =
        (this.executionStats.outputTokens || 0) +
        (isFinite(outTok) ? outTok : 0);
      this.executionStats.totalTokens =
        (this.executionStats.inputTokens || 0) +
        (this.executionStats.outputTokens || 0) +
        (isFinite(thoughtTok) ? thoughtTok : 0) +
        (isFinite(cachedTok) ? cachedTok : 0);
      this.executionStats.estimatedCost =
        (this.executionStats.inputTokens || 0) * 3e-5 +
        (this.executionStats.outputTokens || 0) * 6e-5;
    }
    this.eventEmitter?.emit(AgentEventType.USAGE_METADATA, {
      subagentId: this.subagentId,
      round: turnCounter,
      usage,
      durationMs: Date.now() - roundStreamStart,
      timestamp: Date.now(),
    } as AgentUsageEvent);
  }
}
