/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Subagent-specific execution wrapper around query().
 *
 * Unlike runForkedAgent() (which inherits parent context for prompt-cache
 * hits in compact/session-memory forks), runSubagent() assembles an
 * independent execution context: fresh tool registry from the global pool,
 * its own CompressionPipeline, definition-first reasoning with parent-session
 * fallback, and optionally an independent permission mode.
 *
 * Architecture: invoked by `runAgent()` in `./run-agent.ts`, which owns the
 * surrounding lifecycle (worktree, transcript, hooks, timeout, cleanup) and
 * picks between this function and `runForkedAgent()`.
 */

import type { SystemPrompt } from '../prompts/types.js';
import { restoreToolFileReadState } from '../attachments/transcript-state.js';
import { runLogger } from '../utils/runLogger.js';
import { query } from '../core/agent-loop.js';
import { collectQueryResults } from '../core/query-result-collector.js';
import { CompressionPipeline } from '../compression-v2/pipeline.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  RESOLVED_AGENT_REASONING,
  type LocalAgentDefinition,
} from './types.js';
import type { Message } from '../protocol/transcript/message.js';
import type { ModelStreamUserContent } from '../provider/modelStreamRequest.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type {
  ModelRequestCompletedSnapshot,
  ModelRequestFinishedSnapshot,
} from '../model-request/types.js';
import type { QueryEvent, Terminal } from '../core/query-event.js';
import type { ToolExecutor } from '../tool-executor/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

import type { PermissionMode } from '../permissions/manager/decision/index.js';
import type { PermissionContext } from '../permissions/manager/types.js';
import type { SidechainTranscriptRecorder } from '../services/transcript/writer-handle.js';
import type {
  AttachmentExternalContext,
  AttachmentToolUseContext,
} from '../attachments/types.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import { createAttachmentContext } from '../attachments/get-attachments.js';
import { getCwd, runWithShellSession } from '../utils/Shell.js';
import { getAgentListingDeltaAttachments } from '../attachments/generators/agent-generators.js';
import type { HookCoordinatorAdapter } from '../core/hook-coordinator-types.js';
import {
  attachSubagentMessageContext,
  attachSubagentQueryEventContext,
} from './subagent-message-context.js';
import {
  requestSetIdContext,
  businessInfoContext,
  customContextContext,
  getCustomContextFromContext,
  snapshotCustomContext,
} from '../utils/sessionIdContext.js';
import type { BusinessInfo } from '../qoder/business-info.js';

import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { RequestModelOverride } from '../provider/model/modelSelectContext.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';


import { getForkCompletionBilling } from '../model-request/credit-usage.js';
import { modelConfigFromGeneration } from '../config/generation-config.js';
import {
  generationOverridesFromDefinition,
  readAgentSelectionDefaults,
} from './agentModelConfig.js';
import type { SubagentForkContext } from './subagent-fork-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunSubagentParams {
  /** Agent definition (for permission mode, name). */
  definition: LocalAgentDefinition;
  /** Unique per-invocation identifier (from createAgentId). Used as the key for per-subagent permission modes. */
  agentId: string;
  /** Unmodified task supplied by the launching agent. */
  prompt: ModelStreamUserContent;
  /** Synthetic memory, workspace, and preloaded-skill messages before the task. */
  contextMessages?: Message[];
  /** Agent-specific system prompt (built by buildSubagentSystemPrompt). */
  systemPrompt: SystemPrompt;
  /** Model identifier. */
  model: string;
  /** 本次配置要求；运行模型仍由入口按原优先级解析。 */
  querySelection?: Pick<RequestModelOverride, 'config'>;
  /** Complete parent selection when the child keeps the same model. */
  parentSelection?: ModelSelection;
  /** Tracing / prompt ID. */
  promptId: string;
  /** Parent AgentLoopContext — provides config, global tool registry. */
  context: AgentLoopContext;
  /** Schema surface for this subagent (from buildSubagentRegistries). */
  toolRegistry: ToolRegistry;
  /** Session-level tool executor; owned by the caller. */
  toolExecutor?: ToolExecutor;
  /** Max API round-trips. undefined = no limit. */
  maxTurns?: number;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Optional callback for streaming QueryEvents. */
  onEvent?: (event: QueryEvent) => void;
  /** Root session ID for request/session continuity. */
  sessionId: string;
  /** Parent Agent tool_use_id for parent-child message attribution. */
  parentToolUseId?: string;
  /** Sidechain transcript writer for this subagent invocation. */
  transcriptWriter?: SidechainTranscriptRecorder;
  /** Existing sidechain leaf that the first newly recorded message continues. */
  resumeLeafUuid?: string;
  /**
   * Parent agent's requestSetId, passed explicitly from ToolUseContext.
   * Used for subagent request grouping without AsyncLocalStorage.
   */
  parentRequestSetId?: string;
  /** Opaque SDK context inherited from the explicit parent Agent query. */
  customContext?: Readonly<Record<string, string>>;
  /**
   * Parent agent's BusinessInfo (read-only), passed explicitly from ToolUseContext.
   * Used for subagent lifecycle inheritance without AsyncLocalStorage.
   */
  parentBusinessInfo?: Readonly<BusinessInfo>;
  /**
   * The subagent's own AgentLoopContext (from buildSubagentRegistries).
   * Used to synchronize toolPermissionContext.mode when the subagent
   * declares a custom permissionMode.
   */
  schedulerContext?: AgentLoopContext;
  /**
   * Live conversation / prompt-cache holder created by buildSubagentRegistries
   * and already wired behind `schedulerContext`'s fork accessors. Seeded here
   * with this invocation's context messages and rendered system prompt.
   */
  forkContext: SubagentForkContext;
  /** Independent attachment context; created here when a direct caller omits it. */
  attachmentCtx?: AttachmentToolUseContext;
  /** Hook coordinator for SubagentStop blocking (allows hooks to prevent exit). */
  hookCoordinator?: HookCoordinatorAdapter;
  /** Disable the fresh-agent compression pipeline for short internal runs. */
  disableCompression?: boolean;
  /** Whether an agent without explicit reasoning inherits the parent effort. */
  inheritParentReasoning?: boolean;
  /** Product query source attached to model requests from this invocation. */
  querySource?: string;
}

export interface RunSubagentResult {
  /** All runtime messages yielded during the subagent's query loop. */
  messages: Message[];
  /** Actual model request IDs emitted by the subagent query loop. */
  modelRequestIds?: string[];
  /** Successful model request snapshots emitted by the query loop. */
  modelRequests?: ModelRequestCompletedSnapshot[];
  /** Terminal outcome for every logical model request in the query loop. */
  modelRequestResults?: ModelRequestFinishedSnapshot[];
  /** Server-reported credits consumed by the subagent query loop. */
  credits?: number;
  /** Accumulated token usage across all API calls. */
  totalUsage: NonNullableUsage;
  /** Concatenated text content from all assistant responses. */
  textContent: string;
  /** Terminal status returned by the subagent query loop. */
  terminal?: Terminal;
}

// ---------------------------------------------------------------------------
// Permission mode helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the effective permission mode for a subagent.
 *
 * Rules:
 * - If the subagent declares no permissionMode, inherit the parent's mode.
 * - The subagent can be MORE permissive than the parent (e.g., parent default,
 *   subagent acceptEdits).
 * - The subagent CANNOT override parent modes that are already zero-popup or
 *   more permissive than default (dontAsk, bypassPermissions, acceptEdits,
 *   auto).
 */
export function resolveEffectiveMode(
  parentMode: PermissionMode,
  subagentMode: PermissionMode | undefined,
): PermissionMode {
  if (subagentMode === undefined) {
    return parentMode;
  }
  // Parent dontAsk / bypassPermissions / acceptEdits / auto cannot be
  // overridden by subagent declarations. dontAsk is a zero-popup contract;
  // bypassPermissions, acceptEdits, and auto are parent-level mode decisions
  // that child declarations must not demote.
  if (
    parentMode === 'dontAsk' ||
    parentMode === 'yolo' ||
    parentMode === 'acceptEdits' ||
    parentMode === 'auto'
  ) {
    return parentMode;
  }
  return subagentMode;
}

// ---------------------------------------------------------------------------
// runSubagent
// ---------------------------------------------------------------------------

/**
 * Runs a subagent with its own execution context.
 *
 * Differences from runForkedAgent():
 * - CompressionPipeline with `target: 'subagent'` (fork has none)
 * - reasoning from definition's effort config, falling back to the parent
 *   session's live effort (fork inherits its parent context separately)
 * - Independent permission mode via ToolPermissionContext (fork inherits parent's)
 * - Tools already assembled from global registry (via buildSubagentRegistries)
 */
export async function runSubagent(
  params: RunSubagentParams,
): Promise<RunSubagentResult> {
  const {
    definition,
    agentId,
    prompt,
    contextMessages,
    systemPrompt,
    model,
    promptId,
    context,
    toolRegistry,
    toolExecutor,
    maxTurns,
    signal,
    onEvent,
    sessionId,
    parentToolUseId,
    transcriptWriter,
    resumeLeafUuid,
    parentRequestSetId,
    customContext,
    parentBusinessInfo,
    attachmentCtx: suppliedAttachmentCtx,
    hookCoordinator,
    forkContext,
    disableCompression = false,
    inheritParentReasoning = true,
    querySource,
  } = params;

  // Direct Skill/internal-agent callers do not pass through runAgent(). They
  // still need an independent announcement history from their first request.
  const attachmentCtx =
    suppliedAttachmentCtx ??
    createAttachmentContext(
      runWithShellSession(context.config, getCwd),
      agentId,
      { isMainAgent: false, config: context.config },
    );

  const effectiveCustomContext = customContext ?? getCustomContextFromContext();
  const parentSelection =
    params.parentSelection ??
    context.getCacheSafeQuerySnapshot?.()?.modelResolution;
  const defaults = inheritParentReasoning
    ? readAgentSelectionDefaults(context.config, {
        agentId,
        agentType: definition.name,
      })
    : undefined;
  const compatibilitySelection: RequestModelOverride | undefined = defaults
    ? defaults.key !== undefined || parentSelection?.model.key === model
      ? undefined
      : { key: model }
    : getCompatibilitySelection(params, parentSelection);
  const querySelection = params.querySelection
    ? {
        ...compatibilitySelection,
        config: mergeModelConfig(
          compatibilitySelection?.config,
          params.querySelection.config,
        ),
      }
    : compatibilitySelection;

  const messageContext = {
    sessionId,
    parentToolUseId,
  };
  // Seed the fresh agent's own live state. Nested forks read it through the
  // scheduler context's fork accessors, so they inherit their direct caller
  // instead of the root session.
  forkContext.seed({
    messages: contextMessages,
    systemPrompt,
    toolRegistry,
  });

  // ── Permission mode ──
  // Store the subagent's frontmatter declaration verbatim. When undeclared,
  // declaredMode stays undefined and resolveEffectiveMode will inherit the
  // live parent mode at execute time (CC-aligned: no default 'acceptEdits'
  // upgrade).
  const requestedPlan = isPlanModeRequest(definition.permissionMode);
  const declaredMode = requestedPlan
    ? undefined // plan agents inherit parent mode; plan state handled separately
    : parsePermissionMode(definition.permissionMode);

  // Security gate: if the declared mode is bypass but policy disables it,
  // demote the declaration itself to acceptEdits.
  const safeDeclaredMode =
    declaredMode === 'yolo' && context.config.isYoloModeDisabled()
      ? ('acceptEdits' as PermissionMode)
      : declaredMode;

  if (safeDeclaredMode !== declaredMode) {
    runLogger.warn(
      `[runSubagent] '${definition.name}' (${agentId}) requested bypass mode but it is disabled by policy. Declaring acceptEdits instead.`,
    );
  }

  // The subagent shares the parent permission object and states its own
  // divergence as an override supplier. It has to be a supplier rather than a
  // value: a declared mode only takes effect while the parent sits in a mode
  // the declaration may override, so the resolution has to happen against the
  // parent mode as it is at the moment of the call, not as it was when the
  // subagent started.
  const schedulerContext = params.schedulerContext;
  if (schedulerContext?.permission) {
    const parentPermission = schedulerContext.permission;
    // Merged onto whatever context the caller already carries. A fork pins its
    // own mode and rules, and assigning over it would hand the nested agent the
    // session's wider rules and the ability to prompt.
    const previousContext = schedulerContext.permissionContext;
    (
      schedulerContext as {
        permissionContext?: () => PermissionContext | undefined;
      }
    ).permissionContext = () => {
      const inherited = previousContext?.() ?? {};
      // An inherited context that already pins a mode is a confined fork: keep
      // it whole.
      if (inherited.mode !== undefined) {
        return {
          ...inherited,
          messages: forkContext.getConversationMessages(),
        };
      }
      // No declaration: leave the mode out entirely, so the check resolves
      // against the live session mode and a later mode switch reaches a pending
      // prompt instead of stranding it.
      if (safeDeclaredMode === undefined) {
        return {
          ...inherited,
          messages: forkContext.getConversationMessages(),
        };
      }
      // Declared mode: the effective mode still depends on the parent's *live*
      // mode (a parent in dontAsk/yolo/acceptEdits/auto always wins), so expose
      // a getter. The session's mode field is re-read on every recheck, so a
      // parent switch reaches a pending prompt instead of stranding it.
      return {
        ...inherited,
        messages: forkContext.getConversationMessages(),
        get mode(): PermissionMode {
          return resolveEffectiveMode(
            parentPermission.getPermissionMode(),
            safeDeclaredMode,
          );
        },
      };
    };
  }

  // Plan state isolation: plan-mode subagents hold planModeActive on their
  // own AgentLoopContext (not the global PlanStateManager) to avoid polluting
  // the parent's plan state. The subagent's bound ExitPlanMode tool gates on
  // this flag and clears it to leave plan mode (see agent-setup.ts).
  if (requestedPlan) {
    runLogger.log(
      `[runSubagent] '${definition.name}' (${agentId}) declares 'permissionMode: plan'. Running with isolated plan state.`,
    );
    if (params.schedulerContext) {
      params.schedulerContext.planModeActive = true;
    }
  }

  // ── Compression ──
  const compressionPipeline = disableCompression
    ? undefined
    : new CompressionPipeline({
        target: 'subagent',
        sessionScopeId: promptId,
        agentId,
        modelProviderManager: context.config.getModelProviderManager(),
      });
  // The writer keys parentCursorByScope on (isSidechain, agentId) but only
  // hydrates the main scope from disk, so a resumed agent must be told which
  // leaf to extend or it silently re-roots its transcript. If sidechain cursors
  // ever hydrate lazily, this hint and resumeLeafUuid can both go away.
  let lastRecordedUuid: string | null = resumeLeafUuid ?? null;

  // ── 上下文继承 ──
  // parentRequestSetId / parentBusinessInfo 由上层（runAgent）通过显式参数传入，
  // 避免在此处依赖 AsyncLocalStorage 读取。

  const runCore = async (): Promise<RunSubagentResult> => {
    // No try/finally needed — each subagent has its own schedulerContext
    // (created by buildSubagentRegistries). No shared state to restore.
    const modelRequestIds = new Set<string>();
    const modelRequests: ModelRequestCompletedSnapshot[] = [];
    const modelRequestResults: ModelRequestFinishedSnapshot[] = [];
    const subagentToolRegistry = params.schedulerContext?.toolRegistry;
    const agentRegistry = subagentToolRegistry
      ? context.config.getAgentRegistry?.()
      : undefined;
    const agentAttachmentExternalContext:
      | AttachmentExternalContext
      | undefined =
      subagentToolRegistry && agentRegistry
        ? {
            effectiveModel: model,
            toolRegistry: subagentToolRegistry,
            agentRegistry,
          }
        : undefined;
    const initialInputAttachments = agentAttachmentExternalContext
      ? getAgentListingDeltaAttachments(
          attachmentCtx,
          agentAttachmentExternalContext,
        ).map((attachment) => createAttachmentMessage(attachment))
      : undefined;
    const { fileReadState } = attachmentCtx;
    restoreToolFileReadState(
      fileReadState,
      contextMessages ?? [],
      attachmentCtx.cwd,
    );
    const generator = query({
      querySelection,
      parentSelection,
      turnHookFactories: context.config.turnHookFactories,
      fileReadState,
      prompt,
      userMessage: { isDelegatedTask: true },
      messages: contextMessages,
      sessionId,
      isSubagent: true,
      agentId,
      agentType: definition.name,
      omitGitStatus: definition.omitGitStatus,
      parentRequestSetId,
      parentBusinessInfo,
      customContext: effectiveCustomContext,
      promptId,
      systemPrompt,
      maxTurns,
      signal,
      toolRegistry,
      toolExecutor,
      agentContext: params.schedulerContext ?? context,
      initialInputAttachments,
      attachmentToolRegistry: subagentToolRegistry,
      compressionPipeline,
      config: context.config,
      attachmentCtx,
      hookCoordinator,
      onModelRequestCompleted: (completion) => {
        modelRequests.push(completion);
      },
      onModelRequestFinished: (result) => {
        modelRequestIds.add(result.requestId);
        modelRequestResults.push(result);
      },
      onCacheSafeSnapshot: forkContext.setCacheSafeSnapshot,
      isWorkflowAgent: isWorkflowAgentFromSchedulerContext(
        params.schedulerContext,
      ),
      querySource,
    });

    const { messages, totalUsage, textContent, terminal } =
      await collectQueryResults(
        generator,
        onEvent
          ? (event) =>
              onEvent(attachSubagentQueryEventContext(event, messageContext))
          : undefined,
        async (message) => {
          forkContext.appendMessage(message);
          if (!transcriptWriter) {
            return;
          }
          lastRecordedUuid = await transcriptWriter.recordSidechainMessages(
            [message],
            agentId,
            lastRecordedUuid,
          );
        },
        (message) => attachSubagentMessageContext(message, messageContext),
      );

    const credits = getForkCompletionBilling({
      modelRequests,
      totalUsage,
    }).credits;

    return {
      messages,
      modelRequestIds: Array.from(modelRequestIds),
      modelRequests,
      modelRequestResults,
      credits,
      totalUsage,
      textContent,
      terminal,
    };
  }; // end runCore

  // AsyncLocalStorage 包裹作为额外保障：即使上述显式传参已解决核心问题，
  // 仍用 run() 包裹以确保 queryBody 内部下游代码的 context 一致性。
  let wrappedRunCore = runCore;
  if (parentRequestSetId) {
    const prev = wrappedRunCore;
    wrappedRunCore = () => requestSetIdContext.run(parentRequestSetId, prev);
  }
  if (parentBusinessInfo) {
    const prev = wrappedRunCore;
    wrappedRunCore = () => businessInfoContext.run(parentBusinessInfo, prev);
  }
  if (effectiveCustomContext) {
    const snapshot = snapshotCustomContext(effectiveCustomContext);
    const prev = wrappedRunCore;
    wrappedRunCore = () => customContextContext.run(snapshot, prev);
  }

  // Auto-mode denial counters are per execution: drop any stale bucket for
  // this agent id so a reused id starts fresh, then drop the bucket again
  // when the execution ends (success, failure or abort alike) so finished
  // subagents neither leak counters nor influence later executions. The
  // buckets live on the session's own AutoClassifier, so a subagent of one
  // session can never spend another session's breaker budget.
  const permission = context.config.permission!;
  permission.releaseAutoClassifier(agentId);
  try {
    return await wrappedRunCore();
  } finally {
    permission.releaseAutoClassifier(agentId);
  }
}

function isWorkflowAgentFromSchedulerContext(
  context: AgentLoopContext | undefined,
): boolean {
  // A workflow agent counts only when its full workflow identity is present.
  const owner = context?.internalExecutionOwner;
  return (
    owner?.kind === 'workflow-agent' &&
    !!owner.workflowRunId &&
    !!owner.workflowExecutionId &&
    owner.workflowAgentIndex !== undefined &&
    owner.workflowAttempt !== undefined
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lookup from a normalized permissionMode key → canonical PermissionMode.
 *
 * Keys are the lowercase, separator-stripped form (see
 * normalizePermissionModeKey) so that camelCase and snake_case spellings of the
 * same mode are equivalent — mirroring the `--permission-mode` CLI flag (e.g.
 * `bypass_permissions` ≡ `bypassPermissions`, and `yolo` is the canonical value).
 * `plan` is absent because it is not applied as a per-tool permission mode — it
 * is handled separately as isolated plan state (see isPlanModeRequest /
 * runSubagent).
 */
const NORMALIZED_PERMISSION_MODE_MAP: Record<string, PermissionMode> = {
  default: 'default',
  acceptedits: 'acceptEdits',
  bypasspermissions: 'yolo',
  yolo: 'yolo',
  dontask: 'dontAsk',
  auto: 'auto',
};

/**
 * Normalizes a raw permissionMode string to its lookup key: lowercase with all
 * non-alphanumeric characters stripped. This makes camelCase, snake_case,
 * kebab-case, and case variants of the same mode equivalent.
 */
function normalizePermissionModeKey(mode: string): string {
  return mode.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Returns true if the raw frontmatter permissionMode string requests plan
 * mode. Plan is not a per-tool PermissionMode value — it is an isolated work
 * state for the subagent, held as planModeActive on its AgentLoopContext and
 * gated/cleared by the subagent's bound ExitPlanMode tool (see runSubagent /
 * agent-setup.ts).
 */
function isPlanModeRequest(mode: string | undefined): boolean {
  if (!mode) return false;
  return normalizePermissionModeKey(mode) === 'plan';
}

/**
 * Parses a string permission mode into PermissionMode.
 * Accepts camelCase / snake_case / case variants of the canonical modes.
 * Returns undefined if the string is not a valid mode.
 */
function parsePermissionMode(
  mode: string | undefined,
): PermissionMode | undefined {
  if (!mode) return undefined;
  return (
    NORMALIZED_PERMISSION_MODE_MAP[normalizePermissionModeKey(mode)] ??
    undefined
  );
}

/** 未登记、临时定义及特殊继承入口保留原选模参数，本轮不改变其规则。 */
function getCompatibilitySelection(
  {
    definition,
    model,
    context,
    inheritParentReasoning = true,
  }: RunSubagentParams,
  parentSelection: ModelSelection | undefined,
) {
  const resolvedReasoning = definition[RESOLVED_AGENT_REASONING];
  const preferenceModel = parentSelection?.model;
  const generation = generationOverridesFromDefinition(definition);
  // 关闭继承或仅声明预算的入口保留旧覆盖形式，避免 SDK 换模型时额外带上父 effort。
  const inheritsSelection =
    parentSelection !== undefined &&
    model === parentSelection.model.key &&
    inheritParentReasoning &&
    (resolvedReasoning?.thinkingBudget === undefined ||
      resolvedReasoning.reasoningEffort !== undefined);
  const selectionConfig = modelConfigFromGeneration(
    generation,
    resolvedReasoning?.reasoningEffort ??
      (!inheritsSelection &&
      inheritParentReasoning &&
      resolvedReasoning?.thinkingBudget === undefined
        ? (parentSelection?.config.reasoning?.effort ??
          (preferenceModel
            ? context.config
                .getModelProviderManager()
                .getModelConfig(preferenceModel)?.reasoning?.effort
            : undefined))
        : undefined),
  );
  return inheritsSelection
    ? generation || resolvedReasoning?.reasoningEffort !== undefined
      ? { config: selectionConfig }
      : undefined
    : { key: model, config: selectionConfig };
}
