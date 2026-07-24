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

import { randomUUID } from 'node:crypto';
import { createChildAbortController } from '../../utils/abortController.js';
import { reportError } from '../../utils/errorReporting.js';
import { subagentNameContext } from '../../utils/subagentNameContext.js';
import type { Config } from '../../config/config.js';
import {
  getCurrentAgentDepth,
  getCurrentAgentId,
  getRuntimeContentGenerator,
  isTopLevelSession,
  runWithAgentContext,
  runWithRuntimeContentGenerator,
  spawnBlockReason,
  type RuntimeContentGeneratorView,
} from './agent-context.js';
import {
  createDuplicateProviderToolCallResponse,
  findRepeatedDuplicateProviderToolCall,
  GeminiEventType,
  markDuplicateProviderToolCallResponseSent,
  type ServerGeminiStreamEvent,
  type ToolCallRequestInfo,
} from '../../core/turn.js';
import { LoopDetectionService } from '../../services/loopDetectionService.js';
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
import { isShellProgressData } from '../../tools/tools.js';
import { getInitialChatHistory } from '../../utils/environmentContext.js';
import {
  finalizeToolResponses,
  type ToolResponseBudgetEntry,
} from '../../utils/tool-response-finalizer.js';
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
import {
  dedupeToolCallsById,
  getProviderToolCallId,
} from '../../core/toolCallIdUtils.js';
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
import { getResponseText } from '../../utils/partUtils.js';
import { getThoughtSummary } from '../../utils/thoughtUtils.js';
import {
  isTeammate,
  getTeammateContext,
  runWithTeammateIdentity,
} from '../team/identity.js';
import type { TeammateIdentity } from '../team/types.js';
import {
  getLeaderOnlyToolUnavailableMessage,
  getSubagentPlanToolUnavailableMessage,
  isLeaderOnlyToolUnavailableInSubagent,
  isPlanRequiredTeammateContext,
  isPlanLifecycleToolUnavailableInSubagent,
  SUBAGENT_PLAN_LIFECYCLE_TOOLS,
} from './subagent-plan-tool-policy.js';

/**
 * Result of a single reasoning loop invocation.
 */
/**
 * Tools that must never be available to non-team subagents (including
 * forked agents spawned via the Agent tool).
 * - AgentTool is depth-gated rather than unconditionally excluded:
 *   `isExcluded()` in `prepareTools()` re-admits it while
 *   `canSpawnNestedAgent()` permits another nesting level, and consults
 *   this set only for every other tool. The entry here remains the
 *   fail-closed floor for consumers of the raw set.
 * - Cron tools are session-scoped and should only run from the main session.
 * - TaskStop and SendMessage are parent-side control-plane tools for managing
 *   background subagents; subagents have no agent IDs to manage natively, so
 *   exposing them only widens the surface for cross-agent interference if an
 *   ID leaks via prompt or transcript.
 * - Team management (team_create/team_delete) and task coordination
 *   (task_create/task_update/task_list) are leader/teammate tools. A
 *   non-team Agent subagent has no teammate identity, so isTeammate()
 *   returns false and these tools would treat it as the leader — letting
 *   it delete or rewrite the active team.
 * - Plan lifecycle tools are owned by the caller/main session. A subagent
 *   should return its plan to the caller instead of entering or exiting mode.
 */
export const EXCLUDED_TOOLS_FOR_SUBAGENTS: ReadonlySet<string> = new Set([
  ToolNames.AGENT,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  ToolNames.TASK_STOP,
  ToolNames.SEND_MESSAGE,
  ToolNames.TEAM_CREATE,
  ToolNames.TEAM_DELETE,
  ToolNames.TEAM_PLAN_APPROVAL,
  ToolNames.TASK_CREATE,
  ToolNames.TASK_UPDATE,
  ToolNames.TASK_LIST,
  ...SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  // Worktree management belongs to the parent session — a subagent must
  // never enter or exit the user's worktree state independently.
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
  // V1 session artifacts are owned by the parent daemon session.
  ToolNames.ARTIFACT,
  ToolNames.RECORD_ARTIFACT,
  // FIX-8 (SEC-I1): WORKFLOW is excluded to prevent unbounded recursive
  // fan-out: a subagent spawned by Workflow that calls Workflow would create
  // O(k^n) subagents.
  ToolNames.WORKFLOW,
]);

/**
 * Tools excluded from teammates. Teammates need send_message and the
 * task_* coordination tools to do their job, but they must not be able
 * to create or destroy the team itself — only the leader can do that.
 * Plan lifecycle tools remain caller-owned for teammates too.
 */
const EXCLUDED_TOOLS_FOR_TEAMMATES: ReadonlySet<string> = new Set([
  ToolNames.AGENT,
  ToolNames.CRON_CREATE,
  ToolNames.CRON_LIST,
  ToolNames.CRON_DELETE,
  ToolNames.TASK_STOP,
  ToolNames.TEAM_CREATE,
  ToolNames.TEAM_DELETE,
  ToolNames.TEAM_PLAN_APPROVAL,
  ...SUBAGENT_PLAN_LIFECYCLE_TOOLS,
  // Worktree management belongs to the parent session.
  ToolNames.ENTER_WORKTREE,
  ToolNames.EXIT_WORKTREE,
  // Same recursion guard as EXCLUDED_TOOLS_FOR_SUBAGENTS: the teammate
  // identity propagates through AsyncLocalStorage into anything it
  // spawns, so prepareTools() would keep choosing THIS exclusion set
  // for nested agents — without WORKFLOW here, a teammate-launched
  // workflow re-arms the O(k^n) fan-out the subagent set prevents.
  ToolNames.WORKFLOW,
]);

function getExcludedToolsForCurrentContext(): ReadonlySet<string> {
  if (!isTeammate()) {
    return EXCLUDED_TOOLS_FOR_SUBAGENTS;
  }
  if (!isPlanRequiredTeammateContext()) {
    return EXCLUDED_TOOLS_FOR_TEAMMATES;
  }

  const excluded = new Set(EXCLUDED_TOOLS_FOR_TEAMMATES);
  excluded.delete(ToolNames.EXIT_PLAN_MODE);
  return excluded;
}

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
    const randomPart = randomUUID().replace(/-/g, '').slice(0, 8);
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

    // Forks inherit the parent's complete rendered prompt and history. Other
    // agents, including resumed background agents with initialMessages, still
    // need a fresh startup context merged into their next real user request.
    const inheritsRenderedPrompt =
      this.promptConfig.renderedSystemPrompt !== undefined;
    const hasSkillTool = this.willHaveSkillTool();
    const [envHistory, , startupParts] = inheritsRenderedPrompt
      ? [[], [], this.promptConfig.startupParts ?? []]
      : await getInitialChatHistory(this.runtimeContext, undefined, {
          includeDeferredToolsReminder: false,
          includeAvailableSkillsReminder: hasSkillTool,
        });

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
      chat.setPendingStartupParts(startupParts);
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
   * Returns true if this agent's effective tool surface will include the Skill
   * tool. Used before `prepareTools()` to decide whether to include the
   * startup skills listing.
   */
  private willHaveSkillTool(): boolean {
    if (!this.toolConfig) {
      return !EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.SKILL);
    }
    const asStrings = this.toolConfig.tools.filter(
      (t): t is string => typeof t === 'string',
    );
    const hasWildcard = asStrings.includes('*');
    if (hasWildcard || asStrings.length === 0) {
      return !EXCLUDED_TOOLS_FOR_SUBAGENTS.has(ToolNames.SKILL);
    }
    return asStrings.includes(ToolNames.SKILL);
  }

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

    const excludedFromSubagents = getExcludedToolsForCurrentContext();

    // Nested sub-agents: the AgentTool is normally excluded to prevent
    // recursive spawning, but when maxSubagentDepth permits another level we
    // let it back in. prepareTools() runs inside this sub-agent's own
    // AsyncLocalStorage frame (see AgentHeadless.run / AgentInteractive), so
    // spawnBlockReason() reads this agent's own depth and context — the same
    // shared predicate AgentTool.execute() backstops at runtime.
    //
    // !isTopLevelSession() fails closed: prepareTools() only ever serves
    // agents — never the top-level user session — so a missing agent frame
    // means the launch path forgot runWithAgentContext. Without this check
    // such an agent would be depth-gated as the top-level session and receive
    // the AgentTool even at maxSubagentDepth=1 (codex review: frame-less
    // AgentInteractive.start(), since fixed to establish its frame).
    const nestingAllowed =
      !isTopLevelSession() &&
      spawnBlockReason(this.runtimeContext.getMaxSubagentDepth()) === null;

    // Effective exclusion test. AgentTool is depth-gated (allowed only when
    // this sub-agent is shallow enough to spawn another level); every other
    // control-plane tool follows the static exclusion set unchanged.
    const isExcluded = (name: string | undefined): boolean => {
      if (!name) return false;
      if (name === ToolNames.AGENT) return !nestingAllowed;
      return excludedFromSubagents.has(name);
    };

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
        // have the same "save tokens" lifecycle as the main chat, so hiding
        // schemas would silently break existing `tools: ['*']` configs.
        toolsList.push(
          ...toolRegistry
            .getFunctionDeclarations({ includeDeferred: true })
            .filter((t) => !isExcluded(t.name)),
        );
      } else {
        // Explicit tool list: apply the full subagent exclusion set (not just
        // the recursion guard). This prevents control-plane tools
        // (CRON_CREATE, TASK_STOP, SEND_MESSAGE, etc.) from leaking into
        // explicitly-configured subagents that happen to list them.
        const allowedNames = asStrings.filter((name) => {
          if (isExcluded(name)) {
            this.runtimeContext
              .getDebugLogger()
              ?.debug(
                `[prepareTools] Filtered "${name}" from explicit subagent tool list`,
              );
            return false;
          }
          return true;
        });
        toolsList.push(
          ...toolRegistry.getFunctionDeclarationsFiltered(allowedNames),
        );
      }
      // Also filter inline FunctionDeclaration[] passed directly in toolConfig
      // through the same exclusion test as the registry branches, so the
      // depth-gated AgentTool and every other control-plane tool are handled
      // uniformly (the inline form must not become a leak path for
      // workflow/cron/team tools into a subagent).
      toolsList.push(
        ...onlyInlineDecls.filter((d) => {
          if (isExcluded(d.name)) {
            this.runtimeContext
              .getDebugLogger()
              ?.debug(
                `[prepareTools] Filtered inline declaration "${d.name}" from subagent tool list`,
              );
            return false;
          }
          return true;
        }),
      );
    } else {
      // Inherit all available tools by default when not specified — see the
      // wildcard branch above for why deferred tools are included.
      toolsList.push(
        ...toolRegistry
          .getFunctionDeclarations({ includeDeferred: true })
          .filter((t) => !isExcluded(t.name)),
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
   * has unwound. `inheritedAgentDepth` accompanies it: without the original
   * nesting depth the restored frame recomputes to depth 0, letting a
   * deferred-approved `agent` tool call from a leaf-depth sub-agent bypass
   * maxSubagentDepth.
   *
   * `inheritedTeammateIdentity` restores the in-process teammate identity
   * frame (`teammateIdentityStore`). Deferred approval needs it for the
   * same reason as the others: when a teammate's `send_message` /
   * `task_update` resumes from the UI chain, `getAgentName()` would
   * otherwise be undefined and the tool would mis-attribute the message
   * to the leader (forged `from="leader"` envelope) and slip past the
   * leader-only `isTeammate()` guard. No-op on the reasoning-loop path,
   * where TeamManager already establishes this frame.
   *
   * Exposed (rather than inlined twice) so the contract stays testable in
   * isolation; see `agent-core.test.ts`.
   */
  runInAgentFrames<T>(
    fn: () => Promise<T>,
    inheritedView?: RuntimeContentGeneratorView,
    inheritedAgentId?: string,
    inheritedTeammateIdentity?: TeammateIdentity,
    inheritedAgentDepth?: number,
  ): Promise<T> {
    const runInner = () =>
      subagentNameContext.run(this.name, () => {
        const runWithView = () => this.withRuntimeView(fn, inheritedView);
        // inheritedAgentDepth restores the agent's original nesting depth.
        // Without it the frame recomputes from the UI's frame-less async
        // chain to depth 0, and an approved `agent` tool call from a
        // leaf-depth sub-agent would bypass maxSubagentDepth.
        return inheritedAgentId
          ? runWithAgentContext(
              inheritedAgentId,
              runWithView,
              inheritedAgentDepth,
            )
          : runWithView();
      });
    return inheritedTeammateIdentity
      ? runWithTeammateIdentity(inheritedTeammateIdentity, runInner)
      : runInner();
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
    const handledProviderToolCallIds = chat.getHistoryFunctionResponseIds();
    // Scoped to this reasoning loop. A second duplicate response for the same
    // provider id would keep deterministic providers in a tool-result loop.
    const duplicateProviderToolCallResponseIds = new Set<string>();
    let stickyMaxOutputTokens: number | undefined;
    const loopDetector = new LoopDetectionService(this.runtimeContext);
    loopDetector.reset(
      `${this.runtimeContext.getSessionId()}#${this.subagentId}`,
    );
    const checkSubagentLoop = (event: ServerGeminiStreamEvent): boolean => {
      if (loopDetector.checkAlwaysOnSafeties(event)) {
        return true;
      }
      return (
        !this.runtimeContext.getSkipLoopDetection() &&
        loopDetector.addAndCheckHeuristicLoops(event)
      );
    };

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

      // Per-round child controller so model-SDK retry layers don't accumulate
      // listeners on the long-lived parent. createChildAbortController handles
      // parent propagation; the try/finally below guarantees reverse-cleanup
      // fires for every exit (success, break, return, throw).
      const roundAbortController = createChildAbortController(abortController);

      try {
        const promptId = `${this.runtimeContext.getSessionId()}#${this.subagentId}#${turnCounter++}`;

        const messageParams = {
          message: currentMessages[0]?.parts || [],
          config: {
            abortSignal: roundAbortController.signal,
            tools: [{ functionDeclarations: toolsList }],
            ...(stickyMaxOutputTokens !== undefined
              ? { maxOutputTokens: stickyMaxOutputTokens }
              : {}),
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
        let loopDetectedInStream = false;

        for await (const streamEvent of responseStream) {
          if (roundAbortController.signal.aborted) {
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
            if (checkSubagentLoop({ type: GeminiEventType.Retry })) {
              terminateMode = AgentTerminateMode.LOOP_DETECTED;
              loopDetectedInStream = true;
              break;
            }
            if (streamEvent.maxOutputTokensEscalated !== undefined) {
              stickyMaxOutputTokens = streamEvent.maxOutputTokensEscalated;
            }
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
            const chunkFunctionCalls = resp.functionCalls ?? [];
            functionCalls.push(...chunkFunctionCalls);
            if (
              resp.candidates?.[0]?.finishReason === FinishReason.MAX_TOKENS
            ) {
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

            const thoughtSummary = getThoughtSummary(resp);
            if (
              thoughtSummary &&
              checkSubagentLoop({
                type: GeminiEventType.Thought,
                value: thoughtSummary,
              })
            ) {
              terminateMode = AgentTerminateMode.LOOP_DETECTED;
              loopDetectedInStream = true;
              break;
            }

            const responseText = getResponseText(resp);
            if (
              responseText &&
              checkSubagentLoop({
                type: GeminiEventType.Content,
                value: responseText,
              })
            ) {
              terminateMode = AgentTerminateMode.LOOP_DETECTED;
              loopDetectedInStream = true;
              break;
            }

            for (const fc of chunkFunctionCalls) {
              const toolName = String(fc.name);
              if (
                checkSubagentLoop({
                  type: GeminiEventType.ToolCallRequest,
                  value: {
                    callId: fc.id ?? `${toolName}-${Date.now()}`,
                    providerCallId: getProviderToolCallId(fc),
                    name: toolName,
                    args: (fc.args ?? {}) as Record<string, unknown>,
                    isClientInitiated: false,
                    prompt_id: promptId,
                    response_id: currentResponseId,
                    wasOutputTruncated,
                  },
                })
              ) {
                terminateMode = AgentTerminateMode.LOOP_DETECTED;
                loopDetectedInStream = true;
                break;
              }
            }
            if (loopDetectedInStream) {
              break;
            }

            const finishReason = resp.candidates?.[0]?.finishReason;
            if (
              finishReason &&
              checkSubagentLoop({
                type: GeminiEventType.Finished,
                value: {
                  reason: finishReason,
                  usageMetadata: resp.usageMetadata,
                },
              })
            ) {
              terminateMode = AgentTerminateMode.LOOP_DETECTED;
              loopDetectedInStream = true;
              break;
            }
          }
        }

        if (loopDetectedInStream) {
          break;
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
          terminateMode = AgentTerminateMode.TIMEOUT;
          break;
        }

        // Update token usage if available
        if (lastUsage) {
          this.recordTokenUsage(lastUsage, turnCounter, roundStreamStart);
        }

        if (functionCalls.length > 0) {
          const toolCallResult = await this.processFunctionCalls(
            functionCalls,
            roundAbortController,
            promptId,
            turnCounter,
            toolsList,
            currentResponseId,
            wasOutputTruncated,
            handledProviderToolCallIds,
            duplicateProviderToolCallResponseIds,
          );
          if (toolCallResult.repeatedDuplicateProviderToolCall) {
            terminateMode = AgentTerminateMode.LOOP_DETECTED;
            break;
          }
          currentMessages = toolCallResult.messages;

          const externalInputs = this.drainExternalInputs(options);
          if (externalInputs.length > 0) {
            // Append to the tool-response user message so external input rides
            // alongside the tool results the model is about to see.
            // processFunctionCalls always returns exactly one user-role entry.
            const last = currentMessages[currentMessages.length - 1];
            last.parts!.push(
              ...this.externalInputsToParts(externalInputs, true),
            );
            // Emit one event per injection so observers (e.g. the JSONL
            // transcript writer) can persist each external message as a
            // user-role record. The framing prefix is stripped — the prefix
            // is a model-facing detail, not part of the original message.
            this.emitExternalInputEvents(externalInputs);
          }
          if ((currentMessages[0]?.parts?.length ?? 0) === 0) {
            terminateMode = AgentTerminateMode.ERROR;
            break;
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
      } finally {
        // Reverse-cleanup fires whether the iteration ended normally, broke,
        // returned, or threw — preventing parent-listener accumulation on
        // long-running parents like the per-message roundAbortController in
        // AgentInteractive or the session-lived externalSignal in headless.
        roundAbortController.abort();
      }
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

      const waitAbortController = createChildAbortController(abortController);
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
        // Aborting the child fires reverse-cleanup of its listener on the
        // parent; no-op if it already aborted from the parent or the timeout.
        waitAbortController.abort();
      }
    }
  }

  // ─── Tool Execution ───────────────────────────────────────

  private emitSyntheticToolError(params: {
    callId: string;
    name: string;
    args: Record<string, unknown>;
    errorMessage: string;
    responseParts: Part[];
    resultDisplay: ToolResultDisplay | undefined;
    currentRound: number;
    durationMs?: number;
  }): void {
    this.eventEmitter?.emit(AgentEventType.TOOL_CALL, {
      subagentId: this.subagentId,
      round: params.currentRound,
      callId: params.callId,
      name: params.name,
      args: params.args,
      description: params.errorMessage,
      isOutputMarkdown: false,
      timestamp: Date.now(),
    } as AgentToolCallEvent);

    this.eventEmitter?.emit(AgentEventType.TOOL_RESULT, {
      subagentId: this.subagentId,
      round: params.currentRound,
      callId: params.callId,
      name: params.name,
      success: false,
      error: params.errorMessage,
      responseParts: params.responseParts,
      resultDisplay: params.resultDisplay,
      durationMs: params.durationMs ?? 0,
      timestamp: Date.now(),
    } as AgentToolResultEvent);

    this.recordToolCallStats(
      params.name,
      false,
      params.durationMs ?? 0,
      params.errorMessage,
    );
  }

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
    handledProviderToolCallIds = new Set<string>(),
    duplicateProviderToolCallResponseIds = new Set<string>(),
  ): Promise<{
    messages: Content[];
    repeatedDuplicateProviderToolCall: boolean;
  }> {
    const responseByCallId = new Map<
      string,
      {
        toolName: string;
        responseParts: Part[];
        persistedOutputFiles?: string[];
        durationMs?: number;
      }
    >();
    const uniqueFunctionCalls = dedupeToolCallsById(functionCalls);
    const generatedCallIdBase = randomUUID();
    const callIdByFunctionCall = new Map(
      uniqueFunctionCalls.map((functionCall, index) => [
        functionCall,
        functionCall.id ??
          `${functionCall.name ?? 'tool'}-${generatedCallIdBase}-${index}`,
      ]),
    );

    // Build allowed tool names set for filtering
    const allowedToolNames = new Set(toolsList.map((t) => t.name));
    const repeatedDuplicateCall = findRepeatedDuplicateProviderToolCall(
      uniqueFunctionCalls,
      (fc) => getProviderToolCallId(fc) ?? fc.id,
      handledProviderToolCallIds,
      duplicateProviderToolCallResponseIds,
    );
    if (repeatedDuplicateCall) {
      const providerCallId =
        getProviderToolCallId(repeatedDuplicateCall) ??
        repeatedDuplicateCall.id;
      this.runtimeContext
        .getDebugLogger()
        ?.debug(
          `[processFunctionCalls] Dropping batch after repeated duplicate provider tool-call id: ${providerCallId} (tool: ${String(repeatedDuplicateCall.name)}, round: ${currentRound})`,
        );
      return {
        messages: [{ role: 'user', parts: [] }],
        repeatedDuplicateProviderToolCall: true,
      };
    }

    // Filter unauthorized tool calls before scheduling
    const authorizedCalls: FunctionCall[] = [];
    let duplicateEventIndex = 0;
    for (const fc of uniqueFunctionCalls) {
      const callId = callIdByFunctionCall.get(fc)!;
      const providerCallId = getProviderToolCallId(fc) ?? fc.id;
      const toolName = String(fc.name);
      const args = (fc.args ?? {}) as Record<string, unknown>;

      if (!allowedToolNames.has(fc.name)) {
        const errorMessage = isPlanLifecycleToolUnavailableInSubagent(toolName)
          ? getSubagentPlanToolUnavailableMessage(toolName)
          : isLeaderOnlyToolUnavailableInSubagent(toolName)
            ? getLeaderOnlyToolUnavailableMessage(toolName)
            : `Tool "${toolName}" not found. Tools must use the exact names provided.`;
        const functionResponsePart = {
          functionResponse: {
            id: callId,
            name: toolName,
            response: { error: errorMessage },
          },
        };

        this.emitSyntheticToolError({
          callId,
          name: toolName,
          args,
          errorMessage,
          responseParts: [functionResponsePart],
          resultDisplay: errorMessage,
          currentRound,
        });

        responseByCallId.set(callId, {
          toolName,
          responseParts: [functionResponsePart],
          durationMs: 0,
        });
        continue;
      }

      if (providerCallId) {
        if (handledProviderToolCallIds.has(providerCallId)) {
          markDuplicateProviderToolCallResponseSent(
            providerCallId,
            duplicateProviderToolCallResponseIds,
          );

          const request: ToolCallRequestInfo = {
            callId,
            providerCallId,
            name: toolName,
            args,
            isClientInitiated: true,
            prompt_id: promptId,
            response_id: responseId,
            wasOutputTruncated,
          };
          const response = createDuplicateProviderToolCallResponse(request);
          const errorMessage =
            response.error?.message ??
            'Duplicate provider tool call was ignored.';
          const eventCallId = `${callId}:duplicate:${currentRound}:${duplicateEventIndex++}`;

          this.runtimeContext
            .getDebugLogger()
            ?.debug(
              `[processFunctionCalls] Suppressing duplicate provider tool-call id: ${providerCallId} (tool: ${toolName}, round: ${currentRound})`,
            );

          this.emitSyntheticToolError({
            callId: eventCallId,
            name: toolName,
            args,
            errorMessage,
            responseParts: response.responseParts,
            resultDisplay: response.resultDisplay,
            currentRound,
          });

          responseByCallId.set(callId, {
            toolName,
            responseParts: response.responseParts,
            persistedOutputFiles: response.persistedOutputFiles,
            durationMs: 0,
          });
          continue;
        }
        handledProviderToolCallIds.add(providerCallId);
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
        // Shell liveness heartbeats have no subagent consumer; broadcasting
        // one would overwrite the live output view kept in liveOutputs.
        if (isShellProgressData(outputChunk)) {
          return;
        }
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

          responseByCallId.set(call.request.callId, {
            toolName,
            responseParts: call.response.responseParts,
            persistedOutputFiles: call.response.persistedOutputFiles,
            durationMs: duration,
          });
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
            // Depth pairs with the id: the continuation must re-enter the
            // frame at this agent's original depth, or the depth guard on a
            // deferred-approved `agent` tool call would see depth 0.
            const inheritedAgentDepth = getCurrentAgentDepth();
            // Capture the teammate identity frame too, while the loop
            // frame is still live, so the deferred-approval continuation
            // can restore it. See `runInAgentFrames` for why this matters
            // (mis-attributed `from="leader"` + leader-guard bypass).
            const inheritedTeammateIdentity = getTeammateContext();
            this.eventEmitter?.emit(AgentEventType.TOOL_WAITING_APPROVAL, {
              subagentId: this.subagentId,
              round: currentRound,
              callId: waiting.request.callId,
              name: waiting.request.name,
              description: this.getToolDescription(
                waiting.request.name,
                waiting.request.args,
              ),
              args: waiting.request.args,
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
                  inheritedTeammateIdentity,
                  inheritedAgentDepth,
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
      const callId = callIdByFunctionCall.get(fc)!;
      const providerCallId = getProviderToolCallId(fc) ?? fc.id;
      const args = (fc.args ?? {}) as Record<string, unknown>;
      const request: ToolCallRequestInfo = {
        callId,
        ...(providerCallId ? { providerCallId } : {}),
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
          const responseParts: Part[] = [
            {
              functionResponse: {
                id: req.callId,
                name: req.name,
                response: { error: errorMessage },
              },
            },
          ];
          this.recordToolCallStats(req.name, false, 0, errorMessage);

          this.eventEmitter?.emit(AgentEventType.TOOL_RESULT, {
            subagentId: this.subagentId,
            round: currentRound,
            callId: req.callId,
            name: req.name,
            success: false,
            error: errorMessage,
            responseParts,
            resultDisplay: errorMessage,
            durationMs: 0,
            timestamp: Date.now(),
          } as AgentToolResultEvent);
          responseByCallId.set(req.callId, {
            toolName: req.name,
            responseParts,
            durationMs: 0,
          });
        }
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      try {
        // If already aborted before the listener was registered, resolve
        // immediately to avoid blocking forever.
        if (abortController.signal.aborted) {
          onAbort();
        }

        await scheduler.schedule(requests, abortController.signal);
        await batchDone;
      } finally {
        // Always remove `onAbort` — otherwise a throw from scheduler.schedule
        // or batchDone would leak it on the round controller, and the round's
        // outer try/finally `.abort()` would later fire spurious cancellation
        // TOOL_RESULT events for every un-emitted callId (corrupting the
        // transcript and misleading the model on the next round).
        abortController.signal.removeEventListener('abort', onAbort);
      }
    }

    const orderedResponses: ToolResponseBudgetEntry[] =
      uniqueFunctionCalls.flatMap((fc) => {
        const callId = callIdByFunctionCall.get(fc) ?? fc.id ?? '';
        const response = responseByCallId.get(callId);
        if (!response) return [];
        return [
          {
            callId,
            toolName: response.toolName,
            responseParts: response.responseParts,
            persistedOutputFiles: response.persistedOutputFiles,
          },
        ];
      });
    if (functionCalls.length > 0 && orderedResponses.length === 0) {
      orderedResponses.push({
        callId: 'tool-call-batch',
        toolName: 'tool-call-batch',
        responseParts: [
          {
            text: 'All tool calls failed. Please analyze the errors and try an alternative approach.',
          },
        ],
        persistedOutputFiles: [],
      });
    }
    const finalizedResponses = await finalizeToolResponses(
      this.runtimeContext,
      orderedResponses,
    );
    const toolResponseParts = finalizedResponses.flatMap(
      (response) => response.responseParts,
    );
    this.eventEmitter?.emit(AgentEventType.TOOL_RESPONSES_FINALIZED, {
      subagentId: this.subagentId,
      round: currentRound,
      responses: finalizedResponses.map((response) => {
        const collected = responseByCallId.get(response.callId);
        return {
          callId: response.callId,
          responseParts: response.responseParts,
          ...(collected?.durationMs !== undefined
            ? { durationMs: collected.durationMs }
            : {}),
        };
      }),
      timestamp: Date.now(),
    });

    return {
      messages: [{ role: 'user', parts: toolResponseParts }],
      repeatedDuplicateProviderToolCall: false,
    };
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
    // Context usage tracks prompt size; output isn't in history yet.
    // Guard against malformed provider values (`Infinity`/`NaN`) so the
    // downstream compaction math doesn't get poisoned — `Infinity` is
    // truthy and would otherwise overwrite a valid prior reading.
    const contextTok = inTok || totalTok;
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
