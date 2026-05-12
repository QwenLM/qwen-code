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
import { subagentNameContext } from '../../utils/subagentNameContext.js';
import type { Config } from '../../config/config.js';
import {
  getCurrentAgentId,
  getRuntimeContentGenerator,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
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
  ToolResultDisplay,
} from '../../tools/tools.js';
import { getInitialChatHistory } from '../../utils/environmentContext.js';
import { FinishReason } from '@google/genai';
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
  AgentMessage,
  AgentExternalInput,
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
  AgentExternalMessageEvent,
} from './agent-events.js';
import { AgentEventEmitter, AgentEventType } from './agent-events.js';
import { AgentStatistics, type AgentStatsSummary } from './agent-statistics.js';
import { matchesMcpPattern } from '../../permissions/rule-parser.js';
import { ToolNames } from '../../tools/tool-names.js';
import { DEFAULT_QWEN_MODEL } from '../../config/models.js';
import { type ContextState, templateString } from './agent-headless.js';

/**
 * Result of a single reasoning loop invocation.
 */
/**
 * Tools that must never be available to subagents (including forked agents).
 * - AgentTool prevents recursive subagent spawning.
 * - Cron tools are session-scoped and should only run from the main session.
 * - TaskStop and SendMessage are parent-side control-plane tools for managing
 *   background subagents; subagents have no agent IDs to manage natively, so
 *   exposing them only widens the surface for cross-agent interference if an
 *   ID leaks via prompt or transcript.
 */
export const EXCLUDED_TOOLS_FOR_SUBAGENTS: ReadonlySet<string> = new Set([
  ToolNames.AGENT,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  ToolNames.TASK_STOP,
  ToolNames.SEND_MESSAGE,
  // Worktree management belongs to the parent session — a subagent must
  // never enter or exit the user's worktree state independently.
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
]);

/**
 * Prefix applied to each external message injected into a background agent's
 * reasoning loop via getExternalMessages. Kept here so tests and any future
 * parsers can import the same literal.
 */
export const EXTERNAL_MESSAGE_PREFIX = '[Message from parent agent]:';

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
  /**
   * Optional callback to drain external messages between model rounds.
   * Returned inputs are appended to the next model request as user-role
   * content.
   */
  getExternalMessages?: () => AgentExternalInput[];
  /**
   * Optional callback to wait for external messages while the agent is idle.
   * The callback must resolve with any queued inputs or [] when the signal is
   * aborted.
   */
  waitForExternalMessages?: (
    signal: AbortSignal,
  ) => Promise<AgentExternalInput[]>;
  /**
   * Optional predicate controlling whether a no-tool response should wait for
   * future external inputs instead of finalizing immediately.
   */
  shouldWaitForExternalMessages?: () => boolean;
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
  /**
   * Optional conversation history from a parent session. When provided,
   * this history is prepended to the chat so the agent has prior
   * conversational context (e.g., from AgentInteractive.start()).
   */
  extraHistory?: Content[];
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
  /**
   * Event emitter for this agent. Always present — if the caller doesn't
   * pass one, AgentCore allocates its own so the observable state below
   * is populated regardless of who constructs the agent.
   */
  readonly eventEmitter: AgentEventEmitter;
  readonly hooks?: AgentHooks;
  readonly stats = new AgentStatistics();
  /**
   * When the agent runs with a model different from the parent session,
   * this view is published via AsyncLocalStorage during execution so any
   * `Config.getContentGenerator{,Config}()` call inside the run resolves
   * to the agent's values — even from tools that captured the parent
   * Config at construction.
   */
  readonly runtimeView?: RuntimeContentGeneratorView;

  // Observable state lives on Core (not a wrapper) so headless and
  // background agents can be observed with the same accessors as
  // interactive ones. Populated by listeners set up in the constructor.
  private readonly messages: AgentMessage[] = [];
  private readonly pendingApprovals = new Map<
    string,
    ToolCallConfirmationDetails
  >();
  private readonly liveOutputs = new Map<string, ToolResultDisplay>();
  private readonly shellPids = new Map<string, number>();

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
  };
  /**
   * The prompt token count from the most recent model response.
   * Exposed so UI hooks can seed initial state without waiting for events.
   */
  lastPromptTokenCount = 0;

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
    runtimeView?: RuntimeContentGeneratorView,
  ) {
    const randomPart = Math.random().toString(36).slice(2, 8);
    this.subagentId = `${name}-${randomPart}`;
    this.name = name;
    this.runtimeContext = runtimeContext;
    this.promptConfig = promptConfig;
    this.modelConfig = modelConfig;
    this.runConfig = runConfig;
    this.toolConfig = toolConfig;
    this.eventEmitter = eventEmitter ?? new AgentEventEmitter();
    this.hooks = hooks;
    this.runtimeView = runtimeView;
    this.setupStateListeners();
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
    if (
      !this.promptConfig.systemPrompt &&
      !this.promptConfig.renderedSystemPrompt &&
      !this.promptConfig.initialMessages
    ) {
      throw new Error(
        'PromptConfig must have `systemPrompt`, `renderedSystemPrompt`, or `initialMessages` defined.',
      );
    }
    if (
      this.promptConfig.systemPrompt &&
      this.promptConfig.renderedSystemPrompt
    ) {
      throw new Error(
        'PromptConfig cannot have both `systemPrompt` and `renderedSystemPrompt` defined.',
      );
    }

    // When initialMessages is set, the caller owns the full prior history
    // (including any env bootstrap it wants). Fork relies on this to inherit
    // the parent conversation verbatim without duplicating env messages.
    const hasInitialMessages =
      !!this.promptConfig.initialMessages &&
      this.promptConfig.initialMessages.length > 0;
    const envHistory = hasInitialMessages
      ? []
      : await getInitialChatHistory(this.runtimeContext);

    const startHistory = [
      ...envHistory,
      ...(options?.extraHistory ?? []),
      ...(this.promptConfig.initialMessages ?? []),
    ];

    // Build generationConfig. For fork subagents, `renderedSystemPrompt`
    // carries the parent's exact rendered systemInstruction so the fork
    // shares a byte-identical cache prefix. Otherwise, template
    // `systemPrompt` via buildChatSystemPrompt (which may throw — kept
    // outside the try/catch so template errors surface to the caller).
    const generationConfig: GenerateContentConfig & {
      systemInstruction?: string | Content;
    } = {};
    if (this.promptConfig.renderedSystemPrompt !== undefined) {
      generationConfig.systemInstruction =
        this.promptConfig.renderedSystemPrompt;
    } else if (this.promptConfig.systemPrompt) {
      const systemInstruction = this.buildChatSystemPrompt(context, options);
      if (systemInstruction) {
        generationConfig.systemInstruction = systemInstruction;
      }
    }

    try {
      const chat = new GeminiChat(
        this.runtimeContext,
        generationConfig,
        startHistory,
      );
      // Seed the per-chat token count so the auto-compaction threshold
      // gate sees the inherited history's true size on the first send.
      // Without this, fork subagents start at 0 and the gate NOOPs even
      // when `startHistory` is already huge — first API call can 400.
      chat.setLastPromptTokenCount(this.lastPromptTokenCount);
      return chat;
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
   * inherits all tools (excluding AgentTool to prevent recursion).
   */
  async prepareTools(): Promise<FunctionDeclaration[]> {
    const toolRegistry = this.runtimeContext.getToolRegistry();
    await toolRegistry.warmAll();
    const toolsList: FunctionDeclaration[] = [];

    const excludedFromSubagents = EXCLUDED_TOOLS_FOR_SUBAGENTS;
    // When a subagent has an explicit tools list (not wildcard), only the
    // recursive-spawn guard (AgentTool) is enforced.
    const recursionGuardOnly = new Set<string>([ToolNames.AGENT]);

    if (this.toolConfig) {
      const asStrings = this.toolConfig.tools.filter(
        (t): t is string => typeof t === 'string',
      );
      const hasWildcard = asStrings.includes('*');
      const onlyInlineDecls = this.toolConfig.tools.filter(
        (t): t is FunctionDeclaration => typeof t !== 'string',
      );

      if (
        hasWildcard ||
        (asStrings.length === 0 && onlyInlineDecls.length === 0)
      ) {
        // Subagents inherit the full tool surface — including deferred tools
        // (MCP, low-frequency built-ins). Subagents are one-shot and don't
        // have the same "save tokens" lifecycle as the main chat, and they
        // don't see the "Deferred Tools" section of the system prompt, so
        // hiding schemas would silently break existing `tools: ['*']` configs.
        toolsList.push(
          ...toolRegistry
            .getFunctionDeclarations({ includeDeferred: true })
            .filter((t) => !(t.name && excludedFromSubagents.has(t.name))),
        );
      } else {
        // Explicit tool list: apply the full subagent exclusion set (not just
        // the recursion guard). This prevents control-plane tools
        // (CRON_CREATE, TASK_STOP, SEND_MESSAGE, etc.) from leaking into
        // explicitly-configured subagents that happen to list them.
        toolsList.push(
          ...toolRegistry.getFunctionDeclarationsFiltered(
            asStrings.filter((name) => !excludedFromSubagents.has(name)),
          ),
        );
      }
      // Also filter inline FunctionDeclaration[] passed directly in toolConfig.
      toolsList.push(
        ...onlyInlineDecls.filter(
          (d) => !(d.name && recursionGuardOnly.has(d.name)),
        ),
      );
    } else {
      // Inherit all available tools by default when not specified — see the
      // wildcard branch above for why deferred tools are included.
      toolsList.push(
        ...toolRegistry
          .getFunctionDeclarations({ includeDeferred: true })
          .filter((t) => !(t.name && excludedFromSubagents.has(t.name))),
      );
    }

    // Apply disallowedTools blocklist (supports MCP server-level patterns).
    if (this.toolConfig?.disallowedTools?.length) {
      const disallowed = this.toolConfig.disallowedTools;
      return toolsList.filter((t) => {
        if (!t.name) return true;
        return !disallowed.some((pattern) =>
          t.name!.startsWith('mcp__')
            ? matchesMcpPattern(pattern, t.name!)
            : pattern === t.name,
        );
      });
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
    const inner = () =>
      this._runReasoningLoopInner(
        chat,
        initialMessages,
        toolsList,
        abortController,
        options,
      );
    return this.runInAgentFrames(inner);
  }

  /**
   * Run `fn` inside both ALS frames this agent owns:
   * 1. {@link subagentNameContext} so token-attribution code resolves to
   *    this agent's name.
   * 2. The per-agent runtime ContentGenerator view (when set) so
   *    `Config.getContentGenerator{,Config}()` calls inside resolve to
   *    the agent rather than to the parent Config tools captured at
   *    construction time.
   * 3. The logical owner agent id (when captured) so approved tools that
   *    consult agent context, such as Monitor, keep subagent ownership.
   *
   * Used both around the reasoning loop and around the deferred-approval
   * `onConfirm` continuation — the latter runs from the parent UI's input
   * handler, on a different async chain than the loop, so without this
   * re-entry the resumed tool body would fall back to the parent's view
   * and mis-attribute its tokens.
   *
   * `inheritedView` lets a caller pass an ambient view captured earlier
   * (e.g. at approval-emit time, when the parent's ALS frame is still
   * live) for inheriting agents that own no view themselves. Without it,
   * a nested `model: inherit` agent under a runtime-view-bearing parent
   * would lose that view across the deferred-approval boundary, since
   * the UI invokes `respond` from a fresh async chain where the parent's
   * ALS frame is gone.
   *
   * `inheritedAgentId` does the same for logical agent ownership. It is
   * needed by deferred approval because the user's approval response runs
   * from the parent UI chain, after the subagent's AsyncLocalStorage frame
   * has unwound.
   *
   * Exposed (rather than inlined twice) so the contract stays testable in
   * isolation; see `agent-core.test.ts`.
   */
  runInAgentFrames<T>(
    fn: () => Promise<T>,
    inheritedView?: RuntimeContentGeneratorView,
    inheritedAgentId?: string,
  ): Promise<T> {
    return subagentNameContext.run(this.name, () => {
      const runWithView = () => this.withRuntimeView(fn, inheritedView);
      return inheritedAgentId
        ? runWithAgentContext(inheritedAgentId, runWithView)
        : runWithView();
    });
  }

  /**
   * Wraps `fn` in the effective runtime view: this agent's own view if
   * set, else `inheritedView` if the caller captured one. Internal —
   * public callers should use {@link runInAgentFrames}, which also
   * restores the subagent-name frame.
   */
  private withRuntimeView<T>(
    fn: () => Promise<T>,
    inheritedView?: RuntimeContentGeneratorView,
  ): Promise<T> {
    const view = this.runtimeView ?? inheritedView;
    return view ? runWithRuntimeContentGenerator(view, fn) : fn();
  }

  private async _runReasoningLoopInner(
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
      let wasOutputTruncated = false;

      for await (const streamEvent of responseStream) {
        if (roundAbortController.signal.aborted) {
          abortController.signal.removeEventListener('abort', onParentAbort);
          return {
            text: finalText,
            terminateMode: AgentTerminateMode.CANCELLED,
            turnsUsed: turnCounter,
          };
        }

        // Handle retry events — reset all per-attempt state so a successful
        // retry does not inherit stale data (e.g. wasOutputTruncated) from a
        // previous attempt that may have hit MAX_TOKENS.
        if (streamEvent.type === 'retry') {
          functionCalls.length = 0;
          roundText = '';
          roundThoughtText = '';
          lastUsage = undefined;
          currentResponseId = undefined;
          wasOutputTruncated = false;
          continue;
        }

        // GeminiChat already mutated its own history; surface to the debug
        // log so subagent compactions show up alongside the main session's.
        if (streamEvent.type === 'compressed') {
          this.runtimeContext
            .getDebugLogger()
            .debug(
              `[AGENT-COMPACT] subagent=${this.subagentId} round=${turnCounter} ` +
                `tokens ${streamEvent.info.originalTokenCount} -> ${streamEvent.info.newTokenCount}`,
            );
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
          if (resp.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS) {
            wasOutputTruncated = true;
          }
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
          wasOutputTruncated,
        );

        const externalInputs = this.drainExternalInputs(options);
        if (externalInputs.length > 0) {
          // Append to the tool-response user message so external input rides
          // alongside the tool results the model is about to see.
          // processFunctionCalls always returns exactly one user-role entry.
          const last = currentMessages[currentMessages.length - 1];
          last.parts!.push(...this.externalInputsToParts(externalInputs, true));
          // Emit one event per injection so observers (e.g. the JSONL
          // transcript writer) can persist each external message as a
          // user-role record. The framing prefix is stripped — the prefix
          // is a model-facing detail, not part of the original message.
          this.emitExternalInputEvents(externalInputs);
        }
      } else {
        const immediateExternalInputs = this.drainExternalInputs(options);
        if (immediateExternalInputs.length > 0) {
          currentMessages = this.externalInputsToContent(
            immediateExternalInputs,
          );
          this.emitExternalInputEvents(immediateExternalInputs);
        } else if (options?.shouldWaitForExternalMessages?.()) {
          this.eventEmitter?.emit(AgentEventType.ROUND_END, {
            subagentId: this.subagentId,
            round: turnCounter,
            promptId,
            timestamp: Date.now(),
          } as AgentRoundEvent);
          abortController.signal.removeEventListener('abort', onParentAbort);

          const waitResult = await this.waitForExternalInputs(
            options,
            abortController,
            startTime,
            turnCounter,
          );
          if (waitResult.terminateMode) {
            finalText = roundText.trim();
            terminateMode = waitResult.terminateMode;
            break;
          }
          if (waitResult.inputs.length > 0) {
            currentMessages = this.externalInputsToContent(waitResult.inputs);
            this.emitExternalInputEvents(waitResult.inputs);
            continue;
          }

          if (roundText && roundText.trim().length > 0) {
            finalText = roundText.trim();
            break;
          }
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
          continue;
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

  private drainExternalInputs(
    options?: ReasoningLoopOptions,
  ): AgentExternalInput[] {
    return options?.getExternalMessages?.() ?? [];
  }

  private externalInputText(
    input: AgentExternalInput,
    leadingNewline: boolean,
  ): string {
    const text =
      typeof input === 'string'
        ? `${EXTERNAL_MESSAGE_PREFIX} ${input}`
        : input.text;
    return leadingNewline ? `\n${text}` : text;
  }

  private externalInputsToParts(
    inputs: AgentExternalInput[],
    leadingNewline: boolean,
  ): Part[] {
    return inputs.map((input) => ({
      text: this.externalInputText(input, leadingNewline),
    }));
  }

  private externalInputsToContent(inputs: AgentExternalInput[]): Content[] {
    return [
      {
        role: 'user',
        parts: this.externalInputsToParts(inputs, false),
      },
    ];
  }

  private emitExternalInputEvents(inputs: AgentExternalInput[]): void {
    for (const input of inputs) {
      this.eventEmitter?.emit(AgentEventType.EXTERNAL_MESSAGE, {
        subagentId: this.subagentId,
        kind: typeof input === 'string' ? 'message' : input.kind,
        text: typeof input === 'string' ? input : input.text,
        timestamp: Date.now(),
      });
    }
  }

  private hasTurnBudgetForAnotherRound(
    options: ReasoningLoopOptions | undefined,
    turnCounter: number,
  ): boolean {
    return !options?.maxTurns || turnCounter < options.maxTurns;
  }

  private getRemainingTimeMs(
    options: ReasoningLoopOptions | undefined,
    startTime: number,
  ): number | undefined {
    if (!options?.maxTimeMinutes) return undefined;
    return options.maxTimeMinutes * 60 * 1000 - (Date.now() - startTime);
  }

  private async waitForExternalInputs(
    options: ReasoningLoopOptions,
    abortController: AbortController,
    startTime: number,
    turnCounter: number,
  ): Promise<{
    inputs: AgentExternalInput[];
    terminateMode?: AgentTerminateMode;
  }> {
    while (true) {
      const immediate = this.drainExternalInputs(options);
      if (immediate.length > 0) {
        return { inputs: immediate };
      }

      if (abortController.signal.aborted) {
        return { inputs: [], terminateMode: AgentTerminateMode.CANCELLED };
      }

      if (!this.hasTurnBudgetForAnotherRound(options, turnCounter)) {
        return { inputs: [], terminateMode: AgentTerminateMode.MAX_TURNS };
      }

      const remainingTimeMs = this.getRemainingTimeMs(options, startTime);
      if (remainingTimeMs !== undefined && remainingTimeMs <= 0) {
        return { inputs: [], terminateMode: AgentTerminateMode.TIMEOUT };
      }

      if (!options.waitForExternalMessages) {
        return { inputs: [] };
      }

      if (!options.shouldWaitForExternalMessages?.()) {
        return { inputs: [] };
      }

      const waitAbortController = new AbortController();
      const onAbort = () => waitAbortController.abort();
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      if (abortController.signal.aborted) {
        waitAbortController.abort();
      }
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      if (remainingTimeMs !== undefined) {
        timeout = setTimeout(() => {
          timedOut = true;
          waitAbortController.abort();
        }, remainingTimeMs);
        timeout.unref?.();
      }

      try {
        const inputs = await options.waitForExternalMessages(
          waitAbortController.signal,
        );
        if (abortController.signal.aborted) {
          return { inputs: [], terminateMode: AgentTerminateMode.CANCELLED };
        }
        if (timedOut) {
          return { inputs: [], terminateMode: AgentTerminateMode.TIMEOUT };
        }
        if (inputs.length > 0) {
          return { inputs };
        }
        if (!options.shouldWaitForExternalMessages?.()) {
          return { inputs: [] };
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          return { inputs: [], terminateMode: AgentTerminateMode.CANCELLED };
        }
        if (timedOut) {
          return { inputs: [], terminateMode: AgentTerminateMode.TIMEOUT };
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
        abortController.signal.removeEventListener('abort', onAbort);
      }
    }
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
    wasOutputTruncated = false,
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
    // Tracks calls that already had their executionStartTime broadcast, so
    // onToolCallsUpdate only fires the transition event once per callId even
    // though the callback runs repeatedly while the tool executes.
    const executionStartedEmitted = new Set<string>();
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
            const executing = call as ExecutingToolCall;
            const pid = executing.pid;
            const isNewPid =
              pid !== undefined && !pidMap.has(call.request.callId);
            if (pid !== undefined) {
              pidMap.set(call.request.callId, pid);
            }

            const needsExecutionStartEmit =
              executing.executionStartTime !== undefined &&
              !executionStartedEmitted.has(call.request.callId);
            if (needsExecutionStartEmit) {
              executionStartedEmitted.add(call.request.callId);
            }

            if (isNewPid || needsExecutionStartEmit) {
              // Emit so the agent-view UI can (a) offer interactive shell
              // focus (Ctrl+F) before the tool produces its first output,
              // and (b) start the elapsed-time indicator from the
              // executing-transition timestamp rather than the first output
              // event.
              this.eventEmitter?.emit(AgentEventType.TOOL_OUTPUT_UPDATE, {
                subagentId: this.subagentId,
                round: currentRound,
                callId: call.request.callId,
                outputChunk: executing.liveOutput ?? '',
                pid,
                executionStartTime: executing.executionStartTime,
                timestamp: Date.now(),
              } as AgentToolOutputUpdateEvent);
            }
          }

          if (call.status !== 'awaiting_approval') continue;
          const waiting = call as WaitingToolCall;

          // Emit approval request event for UI visibility
          try {
            const { confirmationDetails } = waiting;
            const { onConfirm: _onConfirm, ...rest } = confirmationDetails;
            // Snapshot the ambient runtime view here, while the loop frame
            // is still live. For inheriting agents (no own runtimeView)
            // this captures the parent's view so the deferred-approval
            // continuation — invoked later from the UI's async chain — can
            // restore it. See `runInAgentFrames` for the wiring.
            const inheritedView = getRuntimeContentGenerator();
            const inheritedAgentId = getCurrentAgentId();
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
                // UI invokes this from its own async chain (outside the
                // reasoning-loop ALS frames), so re-enter both the agent's
                // runtime view AND its name context before the resumed
                // tool body runs. See `runInAgentFrames` for rationale.
                // Also restore the logical owner agent id when present so
                // approved tools such as Monitor keep owner routing.
                await this.runInAgentFrames(
                  () => waiting.confirmationDetails.onConfirm(outcome, payload),
                  inheritedView,
                  inheritedAgentId ?? undefined,
                );
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
        wasOutputTruncated,
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

  // ─── Observable state accessors ────────────────────────────

  getMessages(): readonly AgentMessage[] {
    return this.messages;
  }

  /**
   * Tool calls currently awaiting user approval. Mutated by
   * AgentInteractive's TOOL_WAITING_APPROVAL handler; headless agents
   * never populate this because they run with
   * `getShouldAvoidPermissionPrompts === true`.
   */
  getPendingApprovals(): ReadonlyMap<string, ToolCallConfirmationDetails> {
    return this.pendingApprovals;
  }

  getLiveOutputs(): ReadonlyMap<string, ToolResultDisplay> {
    return this.liveOutputs;
  }

  getShellPids(): ReadonlyMap<string, number> {
    return this.shellPids;
  }

  pushMessage(
    role: AgentMessage['role'],
    content: string,
    options?: { thought?: boolean; metadata?: Record<string, unknown> },
  ): void {
    const message: AgentMessage = {
      role,
      content,
      timestamp: Date.now(),
    };
    if (options?.thought) {
      message.thought = true;
    }
    if (options?.metadata) {
      message.metadata = options.metadata;
    }
    this.messages.push(message);
  }

  setPendingApproval(
    callId: string,
    details: ToolCallConfirmationDetails,
  ): void {
    this.pendingApprovals.set(callId, details);
  }

  deletePendingApproval(callId: string): void {
    this.pendingApprovals.delete(callId);
  }

  clearPendingApprovals(): void {
    this.pendingApprovals.clear();
  }

  // ─── Stats & Events ───────────────────────────────────────

  getEventEmitter(): AgentEventEmitter {
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
   * Note: Assumes tools are warmed via warmAll() before the reasoning loop.
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
   * TOOL_WAITING_APPROVAL is deliberately NOT listened to here because
   * the correct response depends on whether the consumer is interactive
   * (needs to wrap onConfirm with cancel-round behavior) or headless
   * (approvals never fire). AgentInteractive owns that listener and
   * writes into `pendingApprovals` via the public mutator API.
   */
  private setupStateListeners(): void {
    const emitter = this.eventEmitter;

    emitter.on(AgentEventType.ROUND_TEXT, (event: AgentRoundTextEvent) => {
      if (event.thoughtText) {
        this.pushMessage('assistant', event.thoughtText, { thought: true });
      }
      if (event.text) {
        this.pushMessage('assistant', event.text);
      }
    });

    emitter.on(AgentEventType.TOOL_CALL, (event: AgentToolCallEvent) => {
      this.pushMessage('tool_call', `Tool call: ${event.name}`, {
        metadata: {
          callId: event.callId,
          toolName: event.name,
          args: event.args,
          description: event.description,
          renderOutputAsMarkdown: event.isOutputMarkdown,
          round: event.round,
        },
      });
    });

    emitter.on(
      AgentEventType.TOOL_OUTPUT_UPDATE,
      (event: AgentToolOutputUpdateEvent) => {
        this.liveOutputs.set(event.callId, event.outputChunk);
        if (event.pid !== undefined) {
          this.shellPids.set(event.callId, event.pid);
        }
      },
    );

    emitter.on(AgentEventType.TOOL_RESULT, (event: AgentToolResultEvent) => {
      this.liveOutputs.delete(event.callId);
      this.shellPids.delete(event.callId);
      this.pendingApprovals.delete(event.callId);

      const statusText = event.success ? 'succeeded' : 'failed';
      const summary = event.error
        ? `Tool ${event.name} ${statusText}: ${event.error}`
        : `Tool ${event.name} ${statusText}`;
      this.pushMessage('tool_result', summary, {
        metadata: {
          callId: event.callId,
          toolName: event.name,
          success: event.success,
          resultDisplay: event.resultDisplay,
          outputFile: event.outputFile,
          round: event.round,
        },
      });
    });

    // Mirror send_message injections into the observable message stream so
    // the TUI detail dialog shows parent→child messages alongside what the
    // JSONL transcript records. The framing prefix is stripped — that's a
    // model-facing detail, not what the user wants to see in the dialog.
    emitter.on(
      AgentEventType.EXTERNAL_MESSAGE,
      (event: AgentExternalMessageEvent) => {
        this.pushMessage('user', event.text);
      },
    );
  }

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

    // Append user memory (QWEN.md + output-language.md) to ensure subagent respects project conventions
    const userMemory = this.runtimeContext.getUserMemory();
    if (userMemory && userMemory.trim().length > 0) {
      finalPrompt += `\n\n---\n\n${userMemory.trim()}`;
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
    const totalTok = Number(usage.totalTokenCount || 0);
    // Prefer totalTokenCount (prompt + output) for context usage — the
    // output from this round becomes history for the next, matching
    // the approach in geminiChat.ts.
    const contextTok = isFinite(totalTok) && totalTok > 0 ? totalTok : inTok;
    if (isFinite(contextTok) && contextTok > 0) {
      this.lastPromptTokenCount = contextTok;
    }
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
        isFinite(totalTok) ? totalTok : 0,
      );
      // Mirror legacy fields for compatibility
      this.executionStats.inputTokens =
        (this.executionStats.inputTokens || 0) + (isFinite(inTok) ? inTok : 0);
      this.executionStats.outputTokens =
        (this.executionStats.outputTokens || 0) +
        (isFinite(outTok) ? outTok : 0);
      this.executionStats.totalTokens =
        (this.executionStats.totalTokens || 0) +
        (isFinite(totalTok) ? totalTok : 0);
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
