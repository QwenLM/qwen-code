/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { createAttachmentMessage } from '../../attachments/factory.js';
import { getAttachmentMessages } from '../../attachments/get-attachments.js';
import { isContextAttachmentMessage } from '../../attachments/context-messages.js';
import { getEnvironmentAttachments } from '../../attachments/generators/environment-generators.js';
import { drainHookOutputAttachments } from '../../attachments/generators/hook-generators.js';
import { getSessionContextAttachments } from '../../attachments/generators/session-context-generators.js';
import { getSkillListingConfig } from '../../attachments/generators/skill-generators.js';
import { getDateChangeAttachments } from '../../attachments/generators/system-generators.js';
import { extractTodosFromHistory } from '../../attachments/generators/todo-generators.js';
import type { SessionContextReason } from '../../attachments/models/session-context-attachment.js';
import {
  restoreToolFileReadState,
  snapshotAttachmentDeltaState,
} from '../../attachments/transcript-state.js';
import type {
  Attachment,
  AttachmentToolUseContext,
} from '../../attachments/types.js';
import { tryReactiveCompact } from '../../compression-v2/reactive-compact.js';
import {
  calculateTokenWarningStateForContextWindow,
  getEffectiveContextWindowSize,
} from '../../compression-v2/thresholds.js';
import { generationFromModelConfig } from '../../config/generation-config.js';
import type { McpInfo } from '../../mcp/tools/mcp-tool.js';
import { createUserMessage } from '../../protocol/transcript/conversions.js';
import type {
  AttachmentMessage,
  Message,
} from '../../protocol/transcript/message.js';
import type { ModelStreamTool } from '../../provider/modelStreamRequest.js';
import type { QueuedCommand } from '../../services/messageQueueManager.js';
import { loadLatestSessionUsage } from '../../services/session-state-usage.js';

import { uiTelemetryService } from '../../services/session-stats.js';

import {
  TASK_UPDATE_TOOL_NAME,
  WRITE_TODOS_TOOL_NAME,
} from '../../tools/tool-names.js';
import { cloneFileStateCache } from '../../utils/fileStateCache.js';
import { buildModelProjectionOptions } from '../../utils/modelProjectionOptions.js';
import { raceWithAbortSignal } from '../../utils/abort-race.js';
import {
  createRequestTokenAnchor,
  type RequestTokenInput,
} from '../../utils/request-token-count.js';
import { runLogger } from '../../utils/runLogger.js';
import {
  businessInfoContext,
  requestSetIdContext,
} from '../../utils/sessionIdContext.js';
import { getModelVisibleSkillsForTools } from '../../workflows/workflow-skills.js';
import {
  captureParentRequestIdentity,
  type CacheSafeQuerySnapshot,
} from '../../core/cache-safe-query-snapshot.js';
import {
  createCompactRequestResolver,
  type CompressionRequestModel,
} from '../../core/compact-request-resolver.js';
import { logLoopStarted, makeLoopId } from '../../core/query-diagnostics.js';
import { createQueryRequestMessages } from '../../core/query-request-messages.js';
import { resolveTurnBudgetReminders } from '../../core/turn-budget-reminders.js';
import type { QueryEvent } from '../../core/query-event.js';
import { buildReactiveCompactRecoveryState } from '../../core/query-recovery.js';
import {
  createContinuationState,
  getPendingTurnMessages,
  type QueryRuntimeState,
} from '../../core/query-runtime-state.js';
import { PostCompactContextLimitError } from '../../core/query-terminal.js';
import { isRemoteWorkerMode } from '../../utils/headless.js';
import { yieldToEventLoop } from '../handler-support.js';
import { QODER_PROVIDER_ID } from '../../provider/modelProvider.js';
import type { LlmFailureKind } from '../events.js';
import type {
  PreparedRequest,
  QueryModelState,
  QueryRound,
  QueryState,
} from '../state.js';
import {
  buildInterTurnExternalContext,
  drainMidTurnQueue,
  getConsumedMidTurnCommands,
  prepareRequestConversation,
  removeConsumedMidTurnCommands,
  runInFlightDrainBatch,
} from './request-preparation-helpers.js';

/** What a round needs from its handler; the handler owns cancellation and delivery. */
export interface LlmRoundContext {
  readonly state: QueryState;
  readonly round: QueryRound;
  readonly signal: AbortSignal;
  emit(event: QueryEvent): void;
}

/** Everything inference needs; computed once per request. */
export interface AssembledRequest {
  modelRequestId: string;
  responseGroupId: string;
  canonicalModelKey: string;
  model: QueryModelState;
  toolSchemas: ModelStreamTool[];
  conversation: ReturnType<typeof prepareRequestConversation>;
  requestMessagesBuildDurationMs: number;
  projectionOptions: ReturnType<typeof buildModelProjectionOptions>;
  capturedMcpIdentities: Map<string, McpInfo>;
  requestSnapshot: CacheSafeQuerySnapshot;
  completeRequestTokenAnchor: ReturnType<typeof createRequestTokenAnchor>;
  loopId: string;
  extraHeaders?: Record<string, string>;
}

export type PreparationResult =
  | { kind: 'ready'; prepared: PreparedRequest; request: AssembledRequest }
  | {
      kind: 'stopped';
      failure: LlmFailureKind;
      prepared: PreparedRequest;
      error?: unknown;
    };

export function resolveThinkingBudget(
  model: Pick<QueryModelState, 'resolution'>,
): number | undefined {
  const reasoning = model.resolution.config.reasoning;
  if (reasoning?.effort === 'none' || reasoning?.thinking?.type === 'disabled') {
    return 0;
  }
  return reasoning?.thinking?.type === 'enabled'
    ? reasoning.thinking.budgetTokens
    : undefined;
}

export function resolveEffectiveContextWindow(
  state: QueryState,
  model: Pick<QueryModelState, 'resolution'>,
): number | undefined {
  return (
    model.resolution.config.context?.contextWindow ??
    state.input.config.getEffectiveContextWindow?.(model.resolution.model)
  );
}

export function servesCustomProvider(
  model: Pick<QueryModelState, 'resolution'>,
): boolean {
  return model.resolution.model.source !== QODER_PROVIDER_ID;
}

export function getToolSchemas(
  state: QueryState,
  modelKey: string,
): ModelStreamTool[] {
  return (
    state.input.params.toolRegistry?.getSchema(modelKey, {
      // The CLI intentionally has no model allowlist for this prompt behavior.
      // `--bare` is the only minimal mode and never enters a tool-bearing query.
      preReadLineDropped: state.input.params.preReadLineDropped !== false,
    }) ?? []
  );
}

function subagentAgentId(state: QueryState): string | undefined {
  const options = state.input.params;
  return options.isSubagent
    ? (options.agentId ?? options.promptId)
    : undefined;
}

/** Mutable working copy; reported back to Conversation, never written to state. */
interface PreparationWork {
  runtime: QueryRuntimeState;
  model?: QueryModelState;
  sessionContextReason: SessionContextReason;
  interTurnRequestId?: string;
}

function preparedFrom(
  ctx: LlmRoundContext,
  work: PreparationWork,
  extra: Partial<PreparedRequest> = {},
): PreparedRequest {
  return {
    runtime: work.runtime,
    model: work.model,
    sessionContextReason: work.sessionContextReason,
    requestSent: false,
    nextTurnCount: work.runtime.turnCount + 1,
    iterationStartMs: Date.now(),
    toolSchemas: [],
    requestPrefixMessages: [],
    hasPendingUserMessage: false,
    ...extra,
  };
}

export async function prepareRequest(
  ctx: LlmRoundContext,
): Promise<PreparationResult> {
  const { state, round, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const work: PreparationWork = {
    runtime: state.runtime,
    model: state.model,
    sessionContextReason: state.sessionContextReason,
  };

  if (!work.model) await selectInitialModel(ctx, work);
  if (round.reason === 'reactive_compact') {
    const recovered = await runReactiveCompact(ctx, work);
    if (!recovered) {
      return {
        kind: 'stopped',
        failure: 'reactive_compact_failed',
        prepared: preparedFrom(ctx, work),
        error: round.cause,
      };
    }
  }
  if (round.reason === 'tool_results' && options.attachmentCtx) {
    await injectInterTurnAttachments(ctx, work, options.attachmentCtx);
  }

  if (signal.aborted) {
    return {
      kind: 'stopped',
      failure: 'aborted_before_request',
      prepared: preparedFrom(ctx, work),
    };
  }
  return assembleRequest(ctx, work);
}

async function selectInitialModel(
  ctx: LlmRoundContext,
  work: PreparationWork,
): Promise<void> {
  const { state, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const { config, selectInput } = input;
  if (!config.hasModelProviderManager()) {
    throw new Error('A session ModelProvider is required for inference.');
  }
  const manager = config.getModelProviderManager();
  const selected = await manager.select({
    ...selectInput,
    ...(selectInput.purpose === 'compact'
      ? { compactSelection: options.compactSelection }
      : {}),
    signal,
    request: {
      sessionId: input.sessionId,
      turnIndex: state.requestIndex,
      agentId: subagentAgentId(state),
      agentType: options.isSubagent ? options.agentType : undefined,
      cumulativeUsage: state.usage,
    },
  });
  const resolution = { model: selected.model, config: selected.config };
  signal.throwIfAborted();
  let systemPrompt = options.systemPrompt;
  let promptResult;
  if (options.resolveSystemPrompt) {
    promptResult = await options.resolveSystemPrompt(
      resolution.model.key,
      resolution.model,
    );
    systemPrompt = promptResult.blocks;
  }
  const base = { resolution };
  const thinkingBudget = resolveThinkingBudget(base);
  const maxOutputTokens = resolution.config.context?.maxOutputTokens;
  work.model = {
    resolution,
    requestMessages: createQueryRequestMessages(
      await resolveTurnBudgetReminders({
        model: resolution.model,
        purpose: selectInput.purpose,
        isSubagent: options.isSubagent,
        maxTurns: options.maxTurns,
        signal,
      }),
    ),
    key: resolution.model.key,
    systemPrompt,
    promptResult,
    policyLabels: selected.policy
      ? selected.policy.labels
      : options.policyLabels,
    selectionSource: selected.reusedSelection
      ? 'current'
      : selected.policy?.overridden
        ? 'sdk-policy'
        : 'fixed',
    thinkingBudget,
    contextWindow: resolveEffectiveContextWindow(state, base),
    initialThinkingBudget: thinkingBudget,
    initialMaxOutputTokens: maxOutputTokens,
  };
  ctx.round.selection = work.model;
  input.queryEndState.model = resolution.model.key;
  // The runtime starts from the selected output limit.
  work.runtime = { ...work.runtime, maxOutputTokensOverride: maxOutputTokens };
  // The run starts once a model is selected, before its first request.
  const { trigger } = input.turn.runStart({
    taskId: state.lifecycle!.requestSetId,
    promptText: input.promptText,
    isSubagent: options.isSubagent === true,
    isWorkflow: Boolean(options.isWorkflowAgent),
    isRemoteWorker: isRemoteWorkerMode(),
    trigger: options.taskTrigger,
  });
  ctx.round.taskTrigger = trigger;
}

function compactParentFor(
  model: QueryModelState,
): CompressionRequestModel {
  return {
    modelResolution: model.resolution,
    model: model.key,
    source: model.selectionSource,
    policyLabels: model.policyLabels,
    reasoningEffort: model.resolution.config.reasoning?.effort,
    generation: generationFromModelConfig(model.resolution.config),
    contextWindow: model.contextWindow,
  };
}

async function runReactiveCompact(
  ctx: LlmRoundContext,
  work: PreparationWork,
): Promise<boolean> {
  const { state, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const model = work.model!;
  const compressionPipeline = options.compressionPipeline!;
  const reactiveCompactParent = compactParentFor(model);
  const resolveReactiveCompactRequest = createCompactRequestResolver({
    config: input.config,
    parent: reactiveCompactParent,
    isSubagent: options.isSubagent,
    signal,
    sessionId: input.sessionId,
    turnIndex: state.requestIndex,
    agentId: subagentAgentId(state),
    agentType: options.isSubagent ? options.agentType : undefined,
    cumulativeUsage: state.usage,
    logLabel: '[AgentLoop] reactive compact resolve',
  });
  const reactiveResult = await tryReactiveCompact({
    history: work.runtime.messages,
    compressionPipeline,
    compressOptions: {
      promptId: options.promptId,
      rootSessionId: input.sessionId,
      modelResolution: reactiveCompactParent.modelResolution,
      resolveCompactSelection: async () => {
        const request = await resolveReactiveCompactRequest();
        return {
          selection: request.modelResolution,
          policyLabels: request.policyLabels,
          source: request.source,
        };
      },
      config: input.config,
      autoCompactTracking: work.runtime.autoCompactTracking,
      systemPrompt: model.systemPrompt,
      tools: options.toolRegistry ? getToolSchemas(state, model.key) : undefined,
      ...(options.customContext !== undefined
        ? { customContext: options.customContext }
        : {}),
      abortSignal: signal,
      parentRequestSetId: options.parentRequestSetId,
      parentBusinessInfo: options.parentBusinessInfo,
      projectionOptions: buildModelProjectionOptions(
        input.config,
        model.key,
        model.resolution,
      ),
      sessionStateStore: options.sessionStateStore,
      requestPrefixMessages: state.lastRequestPrefixMessages,
    },
  });
  if (!reactiveResult?.newHistory) return false;

  work.sessionContextReason = 'compaction';
  runLogger.debug(
    `[AgentLoop] PTL: reactive compact succeeded, retrying with compacted history`,
  );
  work.runtime = buildReactiveCompactRecoveryState({
    state: work.runtime,
    newHistory: reactiveResult.newHistory,
  });
  if (options.onCompressionCompleted) {
    const finalHistory = await options.onCompressionCompleted(
      work.runtime.messages,
      reactiveResult.newHistory,
    );
    work.runtime = { ...work.runtime, messages: [...finalHistory] };
  }
  const postCompactContextMessages = await getPostCompactContextMessages(
    ctx,
    work,
    work.runtime.messages,
  );
  for (const message of postCompactContextMessages) ctx.emit(message);
  if (postCompactContextMessages.length > 0) {
    work.runtime = {
      ...work.runtime,
      messages: [...work.runtime.messages, ...postCompactContextMessages],
    };
  }
  return true;
}

// Context announcements are best effort; only an abort stops the request.
async function toContextMessages(
  ctx: LlmRoundContext,
  label: string,
  collect: (ctx: AttachmentToolUseContext) => Promise<readonly Attachment[]>,
): Promise<AttachmentMessage[]> {
  const attachmentCtx = ctx.state.input.params.attachmentCtx;
  if (!attachmentCtx) return [];
  try {
    return (await collect(attachmentCtx)).map(createAttachmentMessage);
  } catch (error) {
    ctx.signal.throwIfAborted();
    runLogger.warn(`[AgentLoop] Failed to ${label}:`, error);
    return [];
  }
}

function getEnvironmentMessages(
  ctx: LlmRoundContext,
  history: readonly Message[],
) {
  return toContextMessages(ctx, 'announce the environment', (attachmentCtx) =>
    getEnvironmentAttachments(attachmentCtx, history),
  );
}

function getDateChangeMessages(
  ctx: LlmRoundContext,
  history: readonly Message[],
) {
  return toContextMessages(
    ctx,
    'restore the current date after compaction',
    (attachmentCtx) => getDateChangeAttachments(attachmentCtx, history),
  );
}

function getSessionContextMessages(
  ctx: LlmRoundContext,
  work: PreparationWork,
  history: readonly Message[],
) {
  const options = ctx.state.input.params;
  return toContextMessages(
    ctx,
    'collect the session context',
    async (attachmentCtx) => {
      const promptResult = work.model?.promptResult;
      const hasCustomSystemPrompt = promptResult
        ? promptResult.source === 'custom' || promptResult.source === 'override'
        : options.config?.getCustomSystemPrompt?.() !== undefined;
      return getSessionContextAttachments(attachmentCtx, history, {
        sessionId: options.sessionId,
        isSubagent: options.isSubagent,
        sessionContext: await options.resolveSessionContext?.(),
        reason: work.sessionContextReason,
        isAuxiliary:
          options.preProjectedMessages !== undefined && !options.isSubagent,
        omitGitStatus:
          options.omitGitStatus || (!options.isSubagent && hasCustomSystemPrompt),
        signal: ctx.signal,
      });
    },
  );
}

async function getPostCompactContextMessages(
  ctx: LlmRoundContext,
  _work: PreparationWork,
  history: readonly Message[],
): Promise<AttachmentMessage[]> {
  return (
    await Promise.all([
      getEnvironmentMessages(ctx, history),
      getDateChangeMessages(ctx, history),
    ])
  ).flat();
}

/**
 * Inter-turn attachment injection, before the next request:
 *   A — mid-turn drain of queued prompts and task-notifications
 *   B — changed files, date change, hook outputs, etc.
 *   C — memory prefetch results
 *   D — skill discovery prefetch
 * Slash commands are never drained mid-turn; the main thread drains commands
 * without `targetAgentId`, a subagent those addressed to its `agentId`.
 */
async function injectInterTurnAttachments(
  ctx: LlmRoundContext,
  work: PreparationWork,
  attachmentCtx: AttachmentToolUseContext,
): Promise<void> {
  const { state, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const model = work.model!;
  const isSubagent = options.isSubagent;
  const loopId = makeLoopId(options.promptId, state.requestIndex);
  const nextMessages: Message[] = [...work.runtime.messages];

  let midTurnCommands: QueuedCommand[] = drainMidTurnQueue({
    isSubagent: isSubagent === true,
    subagentAgentId: options.agentId,
    sessionId: input.sessionId,
  });
  const consumedMidTurnCommands = getConsumedMidTurnCommands(midTurnCommands);
  const nextRequestId = randomUUID();
  work.interTurnRequestId = nextRequestId;

  const restoreInterTurnDeltaState = snapshotAttachmentDeltaState(attachmentCtx);
  let interTurnAttachments: Awaited<ReturnType<typeof getAttachmentMessages>> =
    [];
  const deliveredInterTurnAttachments = new Set<
    (typeof interTurnAttachments)[number]
  >();
  let attachmentsDelivered = false;
  try {
    const loadInterTurnAttachments = async () => {
      const modelVisibleToolNames = new Set(
        getToolSchemas(state, model.key).map((tool) => tool.name),
      );
      const isTaskUpdateToolEnabled = modelVisibleToolNames.has(
        TASK_UPDATE_TOOL_NAME,
      );
      return getAttachmentMessages(
        null, // input=null → inter-turn mode; @mention processing skipped
        attachmentCtx,
        midTurnCommands,
        /* skills */ getModelVisibleSkillsForTools(
          input.config,
          [...modelVisibleToolNames],
          { isMainSession: isSubagent !== true },
        ),
        {
          isInitialTurn: false,
          isMainThread: isSubagent !== true,
          isTodoToolEnabled: modelVisibleToolNames.has(WRITE_TODOS_TOOL_NAME),
          isTaskUpdateToolEnabled,
          taskStore:
            isTaskUpdateToolEnabled && input.config.isTasksEnabled()
              ? input.config.getTaskStore()
              : undefined,
          skillListingConfig: await getSkillListingConfig(input.config, {
            model: model.key,
            modelEntry: model.resolution.model,
            contextWindowTokens: model.contextWindow,
          }),
          // Queued pasted images must be resized/uploaded exactly like the
          // idle submit path; otherwise they leave as huge inline base64.
          imagePreparation: { config: input.config, modelKey: model.key },
          signal,
          diagnostics: {
            sessionId: input.sessionId,
            turnId: options.promptId,
            loopId,
            phase: 'inter_turn',
          },
        },
        /* externalContext */ buildInterTurnExternalContext(
          input.config,
          options.attachmentToolRegistry,
        ),
        // Subagents keep plan state in their isolated scheduler context.
        // Never leak the parent session's PlanStateManager into their prompts.
        isSubagent === true ? undefined : input.config.planStateManager,
        nextMessages,
      );
    };
    const inFlightBatchResult = await runInFlightDrainBatch(
      consumedMidTurnCommands,
      loadInterTurnAttachments,
    );
    interTurnAttachments = inFlightBatchResult.value;
    if (inFlightBatchResult.dropConsumedBatch) {
      const droppedUuids = new Set(
        consumedMidTurnCommands.flatMap((command) =>
          command.uuid ? [command.uuid] : [],
        ),
      );
      midTurnCommands = midTurnCommands.filter(
        (command) => !consumedMidTurnCommands.includes(command),
      );
      interTurnAttachments = interTurnAttachments.filter((message) => {
        if (message.type !== 'attachment') return true;
        const sourceUuid = (
          message.attachment as unknown as Record<string, unknown>
        )['source_uuid'];
        return typeof sourceUuid !== 'string' || !droppedUuids.has(sourceUuid);
      });
      for (const commandUuid of droppedUuids) {
        ctx.emit({
          type: 'command_lifecycle',
          uuid: commandUuid,
          state: 'cancelled',
        });
      }
    }
    // Delivery is final once published; there is no consumer acknowledgement.
    for (const attachmentMsg of interTurnAttachments) {
      ctx.emit(attachmentMsg);
      deliveredInterTurnAttachments.add(attachmentMsg);
      nextMessages.push(attachmentMsg);
    }
    attachmentsDelivered = true;
  } finally {
    if (!attachmentsDelivered) {
      restoreInterTurnDeltaState(
        interTurnAttachments.filter(
          (message) =>
            deliveredInterTurnAttachments.has(message) ||
            options.isAttachmentCommitted?.(message) === true,
        ),
      );
    }
  }
  const startedMidTurnCommands = removeConsumedMidTurnCommands(midTurnCommands);
  for (const command of startedMidTurnCommands) {
    if (command.uuid) {
      ctx.emit({
        type: 'command_lifecycle',
        uuid: command.uuid,
        state: 'started',
      });
    }
  }
  work.runtime = {
    ...work.runtime,
    messages: nextMessages,
    stopHookActive:
      work.runtime.stopHookActive ||
      midTurnCommands.some(
        (cmd) => cmd.commandMode === 'task-notification' && cmd.stopHookActive,
      ),
  };
}

async function assembleRequest(
  ctx: LlmRoundContext,
  work: PreparationWork,
): Promise<PreparationResult> {
  const { state, round, signal } = ctx;
  const { input } = state;
  const options = input.params;
  const { config } = input;
  const manager = config.getModelProviderManager();
  const selectInput = input.selectInput;
  const lifecycle = state.lifecycle!;
  const isSubagent = options.isSubagent;
  const sid = input.sessionId;
  const promptId = options.promptId;
  const model = { ...work.model! };
  work.model = model;

  // 输出升级重试也通过 select；推理与缓存快照只消费最终配置。
  const requestedOutputTokens = work.runtime.maxOutputTokensOverride;
  if (
    requestedOutputTokens !== undefined &&
    requestedOutputTokens !== model.resolution.config.context?.maxOutputTokens
  ) {
    model.resolution = await raceWithAbortSignal(
      manager.select({
        purpose: selectInput.purpose,
        overrideSelection: selectInput.overrideSelection,
        ...(selectInput.workdirs ? { workdirs: selectInput.workdirs } : {}),
        modelResolution: model.resolution,
        adjustment: {
          kind: 'output-limit',
          maxOutputTokens: requestedOutputTokens,
        },
        request: {
          sessionId: sid,
          turnIndex: state.requestIndex,
          agentId: subagentAgentId(state),
        },
        signal,
      }),
      signal,
    );
  }
  const iterationReasoningEffort = model.resolution.config.reasoning?.effort;
  const iterationGeneration = generationFromModelConfig(model.resolution.config);
  const modelProjectionOptions = buildModelProjectionOptions(
    config,
    model.key,
    model.resolution,
  );

  // Direct subagent starts and history-only resumes bypass input processing.
  // Check the retained announcements before accounting for the next request;
  // a candidate advances the baseline only once it enters durable history.
  const environmentMessages = await getEnvironmentMessages(
    ctx,
    work.runtime.messages,
  );
  if (environmentMessages.length > 0) {
    for (const message of environmentMessages) ctx.emit(message);
    work.runtime = {
      ...work.runtime,
      messages: [...work.runtime.messages, ...environmentMessages],
    };
  }

  // Materialize every request-only message before compression accounting.
  // The durable pending user turn, startup context and hook output must count
  // toward the threshold, but none of them may enter the compressible history
  // or be folded into the compact summary.
  const durablePendingTurnMessages = getPendingTurnMessages(work.runtime);
  const { newMessages, pendingTurnMessages } = model.requestMessages.prepare(
    work.runtime,
  );
  for (const message of newMessages) ctx.emit(message);

  // Background (async) hooks may have produced context since the last model
  // turn. Drain before compression so the threshold sees the same tail that
  // the provider request will see.
  if (options.hookCoordinator) {
    const asyncContext = options.hookCoordinator.drainPendingAsyncContext();
    if (asyncContext) {
      runLogger.log(
        `[AgentLoop] Injecting async hook context (${asyncContext.length} chars)`,
      );
      const asyncContextMessage = createUserMessage(asyncContext, {
        isMeta: true,
      });
      ctx.emit(asyncContextMessage);
      pendingTurnMessages.push(asyncContextMessage);
    }
  }

  // Hooks may finish after the initial state has been materialized. Include
  // those late request-only attachments in this iteration's threshold input.
  const attachmentCtx = options.attachmentCtx;
  if (
    attachmentCtx &&
    (attachmentCtx.pendingHookOutputs.length > 0 ||
      attachmentCtx.pendingHookAttachments.length > 0)
  ) {
    for (const att of drainHookOutputAttachments(attachmentCtx)) {
      const msg = createAttachmentMessage(att);
      ctx.emit(msg);
      pendingTurnMessages.push(msg);
    }
  }

  const toolSchemas = getToolSchemas(state, model.key);
  // 普通历史与 fork 前缀共用准备入口；压缩后只替换 state，再调用同一入口。
  const prepareConversation = (
    latestUsage?: RequestTokenInput['latestUsage'],
  ) =>
    prepareRequestConversation({
      state: work.runtime,
      pendingTurnMessages,
      startupMemoryPrefix: input.startupMemoryPrefix,
      model: model.key,
      systemPrompt: model.systemPrompt,
      tools: toolSchemas,
      projectionOptions: modelProjectionOptions,
      latestUsage,
    });
  let latestUsage: RequestTokenInput['latestUsage'] =
    await loadLatestSessionUsage(options.sessionStateStore).catch(() => null);
  let conversation = prepareConversation(latestUsage);
  let requestMessagesBuildDurationMs = conversation.messagesBuildDurationMs;
  const compressionPipeline = options.compressionPipeline;
  // Check the exact next request before dispatch. Compaction receives the
  // same count as the capacity guard unless it changes the request history.
  if (compressionPipeline) {
    // The pending user turn is excluded so the fork-compact summarizer never
    // folds an unsent prompt or its input attachments into the summary. The
    // complete turn still counts toward the threshold.
    const compressionInput = conversation.history;
    const compactParent = compactParentFor(model);
    const resolveCompactRequest = createCompactRequestResolver({
      config,
      parent: compactParent,
      isSubagent,
      signal,
      sessionId: sid,
      turnIndex: state.requestIndex,
      agentId: subagentAgentId(state),
      agentType: isSubagent ? options.agentType : undefined,
      cumulativeUsage: state.usage,
      logLabel: '[AgentLoop] compact resolve',
    });
    // forkedAgent calls inside the pipeline (e.g. memory-fork) inherit the
    // parent requestSetId / businessInfo through AsyncLocalStorage.
    const result = await requestSetIdContext.run(lifecycle.requestSetId, () =>
      businessInfoContext.run(lifecycle.businessInfo, () =>
        compressionPipeline.compress(compressionInput, {
          promptId,
          force: false,
          rootSessionId: sid,
          trigger: 'auto',
          autoCompactTracking: work.runtime.autoCompactTracking,
          modelResolution: compactParent.modelResolution,
          resolveCompactSelection: async () => {
            const request = await resolveCompactRequest();
            return {
              selection: request.modelResolution,
              policyLabels: request.policyLabels,
              source: request.source,
            };
          },
          config,
          systemPrompt: model.systemPrompt,
          tools: toolSchemas,
          ...(options.customContext !== undefined
            ? { customContext: options.customContext }
            : {}),
          abortSignal: signal,
          parentRequestSetId: lifecycle.requestSetId,
          parentBusinessInfo: lifecycle.businessInfo,
          projectionOptions: modelProjectionOptions,
          requestTokenCount: conversation.tokenCount,
          sessionStateStore: options.sessionStateStore,
          pendingTurnForThreshold:
            pendingTurnMessages.length > 0 ? pendingTurnMessages : undefined,
          requestPrefixMessages: conversation.prefixMessages,
        }),
      ),
    );

    if (result.newHistory) {
      work.sessionContextReason = 'compaction';
      if (state.toolUseContext.fileReadState)
        restoreToolFileReadState(
          state.toolUseContext.fileReadState,
          result.newHistory,
          attachmentCtx?.cwd ??
            options.workdirs?.[0] ??
            config.getTargetDir() ??
            process.cwd(),
        );
      // Save lastKnownTodos before the pre-compaction history is discarded,
      // in case finalizePostCompact (inside onCompressionCompleted) throws.
      if (attachmentCtx) {
        attachmentCtx.lastKnownTodos = extractTodosFromHistory(compressionInput);
      }

      let compressed: Message[] = result.newHistory;
      if (options.onCompressionCompleted) {
        const onCompressionCompleted = options.onCompressionCompleted;
        try {
          const extended = await requestSetIdContext.run(
            lifecycle.requestSetId,
            () =>
              businessInfoContext.run(lifecycle.businessInfo, () =>
                onCompressionCompleted(compressionInput, compressed),
              ),
          );
          compressed = [...extended] as Message[];
        } catch (err) {
          runLogger.warn('[query] onCompressionCompleted error:', err);
        }
      }

      // Replay the entire post-compact history (boundary + summary +
      // preserved tail) so consumers can rebuild visible session state.
      for (const message of compressed) ctx.emit(message);

      const messagesAfterCompression = durablePendingTurnMessages
        ? [...compressed, ...durablePendingTurnMessages]
        : compressed;
      const postCompactContextMessages = await getPostCompactContextMessages(
        ctx,
        work,
        messagesAfterCompression,
      );
      for (const message of postCompactContextMessages) ctx.emit(message);
      const nextMessages = [
        ...messagesAfterCompression,
        ...postCompactContextMessages,
      ];
      if (durablePendingTurnMessages) {
        pendingTurnMessages.push(...postCompactContextMessages);
      }

      work.runtime = createContinuationState(
        work.runtime,
        { messages: nextMessages },
        { reason: 'next_turn' },
      );
      // 历史已经替换，不复用压缩前的 usage 或投影结果。
      latestUsage = undefined;
      conversation = prepareConversation();
      requestMessagesBuildDurationMs += conversation.messagesBuildDurationMs;
      if (!isSubagent && conversation.tokenCount.tokens > 0) {
        uiTelemetryService.setLastPromptTokenCount(
          conversation.tokenCount.tokens,
        );
      }
    }
  }

  // Git is a snapshot of the retained conversation. Choose it after
  // compaction: collecting before it would preserve an unsent old snapshot
  // with the pending user turn instead of reading the post-compact state.
  const sessionContextMessages = await getSessionContextMessages(
    ctx,
    work,
    work.runtime.messages,
  );
  if (sessionContextMessages.length > 0) {
    for (const message of sessionContextMessages) ctx.emit(message);
    work.runtime = {
      ...work.runtime,
      messages: [...work.runtime.messages, ...sessionContextMessages],
    };
    if (durablePendingTurnMessages) {
      pendingTurnMessages.push(...sessionContextMessages);
    }
    conversation = prepareConversation(latestUsage);
    requestMessagesBuildDurationMs += conversation.messagesBuildDurationMs;
  }

  const modelRequestId =
    work.interTurnRequestId ??
    (round.requestIndex === 1 ? options.initialModelRequestId : undefined) ??
    randomUUID();
  const responseGroupId = randomUUID();
  const baseExtra = {
    modelRequestId,
    responseGroupId,
    toolSchemas,
    projectionOptions: modelProjectionOptions,
    requestPrefixMessages: conversation.prefixMessages,
    hasPendingUserMessage: durablePendingTurnMessages !== undefined,
  };

  // Count once for compression and the fallback capacity check. Keep the
  // provider's prompt-too-long recovery reachable when compaction is installed.
  const automaticContextRecoveryAvailable = compressionPipeline !== undefined;
  if (
    options.querySource === 'tui' &&
    !isSubagent &&
    model.contextWindow !== undefined &&
    !automaticContextRecoveryAvailable
  ) {
    const warningWindow = getEffectiveContextWindowSize(
      model.resolution.model,
      model.contextWindow,
    );
    if (
      calculateTokenWarningStateForContextWindow(
        conversation.tokenCount.tokens,
        warningWindow,
      ).isAtBlockingLimit
    ) {
      return {
        kind: 'stopped',
        failure: 'context_limit',
        prepared: preparedFrom(ctx, work, baseExtra),
        error: new PostCompactContextLimitError(),
      };
    }
  }

  // Let consumers read the preparation messages; one that closed on them
  // stops the query before the request is sent.
  await yieldToEventLoop();
  if (signal.aborted) {
    return {
      kind: 'stopped',
      failure: 'aborted_before_request',
      prepared: preparedFrom(ctx, work, baseExtra),
    };
  }

  const requestIndex = round.requestIndex;
  const loopId = makeLoopId(promptId, requestIndex);
  const selectedModel = model.resolution.model;
  // 本轮归因固定使用请求模型，后续 Skill 切模只影响下一轮。
  const canonicalModelKey = selectedModel.key;

  // 本次请求捕获的身份同时供执行和历史使用，后续请求重新创建。
  const capturedMcpIdentities = new Map<string, McpInfo>();
  const iterationStartMs = Date.now();
  const nextTurnCount = work.runtime.turnCount + 1;
  logLoopStarted({
    sessionId: sid,
    promptId,
    loopId,
    requestIndex,
    model: canonicalModelKey,
    requestMessageCount: conversation.messages.length,
    requestBaseHistoryLength: conversation.history.length,
    hasPendingUserMessage: durablePendingTurnMessages !== undefined,
    toolSchemaCount: toolSchemas.length,
  });

  round.dispatch = {
    modelRequestId,
    responseGroupId,
    modelKey: model.key,
    modelEntry: selectedModel,
    toolUseContext: {
      ...state.toolUseContext,
      requestId: modelRequestId,
      mcpToolIdentities: capturedMcpIdentities,
      modelDisplayName: selectedModel.displayName,
      modelKey: canonicalModelKey,
      modelEntry: selectedModel,
    },
  };

  const requestFileReadState =
    options.onCacheSafeSnapshot && state.toolUseContext.fileReadState
      ? cloneFileStateCache(state.toolUseContext.fileReadState)
      : undefined;
  let parentTurn: CacheSafeQuerySnapshot['completedTurn'];
  if (options.onCacheSafeSnapshot && !isSubagent) {
    const requestIdentity = captureParentRequestIdentity(config);
    if (requestIdentity) {
      parentTurn = {
        sessionId: sid,
        ...(options.sourceSessionId
          ? { sourceSessionId: options.sourceSessionId }
          : {}),
        promptId,
        requestSetId: lifecycle.requestSetId,
        requestIdentity,
        predictionIdentity: requestIdentity,
        ...(lifecycle.businessInfo
          ? { businessInfo: lifecycle.businessInfo }
          : {}),
        ...(selectInput.workdirs
          ? { workdirs: [...selectInput.workdirs] }
          : {}),
        ...(options.customContext
          ? { customContext: { ...options.customContext } }
          : {}),
      };
    }
  }
  const requestSnapshot: CacheSafeQuerySnapshot = {
    modelResolution: model.resolution,
    fileReadState: requestFileReadState,
    systemPrompt: model.systemPrompt,
    requestPrefixMessages: [...conversation.prefixMessages],
    contextAttachmentMessages: options.onCacheSafeSnapshot
      ? work.runtime.messages.filter(isContextAttachmentMessage)
      : undefined,
    forkContextMessages: [...conversation.messages],
    model: canonicalModelKey,
    toolSchemas,
    maxOutputTokens: model.resolution.config.context?.maxOutputTokens,
    thinkingBudget: model.thinkingBudget,
    reasoningEffort: iterationReasoningEffort,
    generation: iterationGeneration,
    contextWindow: model.contextWindow,
  };

  ctx.emit({ type: 'request_start' as const });

  const completeRequestTokenAnchor = createRequestTokenAnchor({
    model: canonicalModelKey,
    messages: [],
    normalizedMessages: conversation.messages,
    systemPrompt: model.systemPrompt,
    tools: toolSchemas,
    projectionOptions: modelProjectionOptions,
  });
  // Streaming tools can fork before the assistant response is complete.
  // Publish the exact request prefix first; append the response after sampling.
  options.onCacheSafeSnapshot?.(requestSnapshot);

  const prepared = preparedFrom(ctx, work, {
    ...baseExtra,
    requestSent: true,
    nextTurnCount,
    iterationStartMs,
    canonicalModelKey,
    requestSnapshot,
    parentTurn,
  });
  return {
    kind: 'ready',
    prepared,
    request: {
      modelRequestId,
      responseGroupId,
      canonicalModelKey,
      model,
      toolSchemas,
      conversation,
      requestMessagesBuildDurationMs,
      projectionOptions: modelProjectionOptions,
      capturedMcpIdentities,
      requestSnapshot,
      completeRequestTokenAnchor,
      loopId,
      extraHeaders:
        requestIndex === 1 && options.isSubagent !== true
          ? options.extraHeaders
          : undefined,
    },
  };
}


