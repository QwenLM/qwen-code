/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview getAttachments() and getAttachmentMessages() — the main
 * attachment aggregation functions.
 *
 * getAttachments() orchestrates all generators in three layers:
 *   Layer 1 (sequential): user input processing (@mentions)
 *   Layer 2 (parallel):   state-based generators (changed files, skills, date)
 *   Layer 3 (parallel):   main-thread-only generators (IDE context)
 *
 * A 10-second absolute timeout applies to all generators. Failed generators
 * are silently discarded (silent degradation via maybe()).
 */

import type { Config } from '../config/config.js';
import { noteHumanTurn } from '../messaging/outbound-tracking.js';
import { PlanModeExitAttachment } from './models/plan-attachments.js';
import { createAttachmentMessage } from './factory.js';
import {
  maybe,
  withTimeout,
  type AttachmentGeneratorDiagnostics,
} from './maybe.js';
import {
  processAtMentionedFiles,
  getChangedFiles,
} from './generators/file-generators.js';
import {
  getSkillListingAttachments,
  type SkillListingConfig,
} from './generators/skill-generators.js';
import { getDateChangeAttachments } from './generators/system-generators.js';
import { getEnvironmentAttachments } from './generators/environment-generators.js';
import {
  seedStaticMemoryPaths,
  getRelevantMemoriesAttachments,
} from './generators/memory-generators.js';
import {
  getPlanModeAttachments,
  getPlanModeReentryAttachment,
  getPlanModeExitAttachment,
  getPlanModeInterTurnAttachment,
  getVerifyPlanReminderAttachment,
} from './generators/plan-generators.js';
import {
  getAutoModeAttachments,
  getAutoModeExitAttachment,
  getUltraEffortAttachments,
} from './generators/auto-mode-generators.js';
import { getGoalStateAttachment } from './generators/goal-generators.js';
import { drainHookOutputAttachments } from './generators/hook-generators.js';
import { getTeamContextAttachment } from './generators/team-generators.js';
import { processMcpResourceMentions } from './generators/mcp-resource-generators.js';
import { getMcpInstructionsDeltaAttachments } from './generators/mcp-generators.js';
import { getLazyMcpReminderAttachments } from './generators/mcp-lazy-generator.js';
import {
  getAvailableAgentTypeNames,
  getAgentListingDeltaAttachments,
  processAgentMentions,
} from './generators/agent-generators.js';
import { processPeerMentions } from './generators/peer-mention-generators.js';
import { getWorkflowKeywordReminderAttachments } from './generators/workflow-generators.js';
import {
  drainPostCompactRestoreAttachments,
  drainPostCompactPlanAttachment,
  drainPendingPostCompactDeltaAttachments,
} from './generators/restore-generators.js';
import { getTodoReminderAttachments } from './generators/todo-generators.js';
import { getTaskReminderAttachments } from './generators/task-generators.js';
import type { TaskStore } from '../tasks/task-store.js';
import {
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
  createToolFileStateCache,
} from '../utils/fileStateCache.js';
import { getAgentContext } from '../utils/agentContext.js';
import {
  emitSessionPhaseFinished,
  emitSessionPhaseStarted,
} from '../utils/diagnosticInterceptors.js';

import {
  type Attachment,
  type AttachmentMessage,
  type AttachmentToolUseContext,
  type AttachmentExternalContext,
  type QueuedCommand,
  QueuedCommandAttachment,
} from './types.js';
import type { Message } from '../protocol/index.js';
import type {
  ModelInputContentBlock,
  ModelStreamUserContent,
} from '../provider/modelStreamRequest.js';
import type { PastedContent } from '../input/types.js';
import type { SkillDefinition } from '@qwen-code/resource';
import type { PlanStateManager } from '../plan/planStateManager.js';
import {
  preparePastedImage,
  resizePastedImage,
} from '../input/image-pipeline.js';
import { mapWithConcurrency } from '../utils/generators.js';
import { runLogger } from '../utils/runLogger.js';
import { API_MAX_MEDIA_PER_REQUEST } from '../utils/constants.js';
import type { ImagePreparationContext } from '../hooks/imagePrepare.js';

/** Absolute timeout for optional attachment generators (ms). */
const ATTACHMENT_TIMEOUT_MS = 10_000;

/** Options for getAttachments(). */
export interface GetAttachmentsOptions {
  /**
   * Whether this is the main thread (affects IDE attachment generation).
   * Subagents should pass false to skip IDE-only generators.
   * @default true
   */
  isMainThread?: boolean;

  /** Skip skill discovery/listing generation. */
  skipSkillDiscovery?: boolean;

  /** Whether this is the first turn for this agent (affects skill delta). */
  isInitialTurn?: boolean;

  /**
   * Whether the write_todos tool is currently enabled for this session.
   * When false or omitted, todo_reminder generation is skipped.
   */
  isTodoToolEnabled?: boolean;

  /**
   * Whether TaskUpdate is present in the current model-visible tool set.
   * Task reminders are not useful when the model cannot update task state.
   */
  isTaskUpdateToolEnabled?: boolean;

  /** Persistent task store used for task reminders. */
  taskStore?: Pick<TaskStore, 'listTasks'>;

  /** Configuration for skill listing generation. */
  skillListingConfig?: SkillListingConfig;

  /** Raw user input before slash/command expansion; used by keyword reminders. */
  preExpansionInput?: string | null;

  /**
   * Whether a human typed this prompt into the local interactive composer.
   *
   * Gates peer-session `@`-mentions, which edit turn content and cost a peer
   * enumeration. Unlike its neighbours here, this defaults to **false**: new
   * capabilities ship TUI-first, and a surface added later should get nothing
   * until someone opts it in rather than inheriting it by omission.
   *
   * Distinct from `isMainThread` even though the two coincide at today's shared
   * call site: that one asks "is this the main agent rather than a sub-agent",
   * this one asks "did a human type it locally".
   *
   * @default false
   */
  isTuiPrompt?: boolean;

  /** Current prompt explicitly ignored the local UltraCode keyword. */
  suppressWorkflowKeyword?: boolean;

  /** Current effective preference for the local-TUI keyword trigger. */
  workflowKeywordTriggerEnabled?: boolean;

  /** Derived live UltraCode state for persistent enter/sparse/exit reminders. */
  ultracodeActive?: boolean;

  /**
   * This is a non-meta prompt submitted by a user to the primary session.
   * UltraCode session reminders are never emitted for internal continuations.
   */
  ultracodeRegularUserPrompt?: boolean;

  /** Model context for queued input's internal image preparation hook. */
  imagePreparation?: ImagePreparationContext;

  /** Abort signal for queued-command image resize/upload work. */
  signal?: AbortSignal;

  /** Session diagnostics correlation for attachment generator timing. */
  diagnostics?: AttachmentGeneratorDiagnostics;
}

/**
 * Aggregate all attachment generators and return the combined list.
 *
 * @param input - User input text (null for tool-call-continuation turns)
 * @param ctx - Tool use context (readFileState, agentId, cwd, etc.)
 * @param queuedCommands - Commands queued for this agent
 * @param skills - Current skill list from SkillManager (null to skip)
 * @param options - Generation options
 * @param externalContext - External system references (memory, plan mode, agents, etc.)
 * @param planStateManager - Session-scoped plan lifecycle state (optional; plan attachments
 *                           are skipped when not provided)
 * @param messages - Current conversation history (used to derive plan attachment count)
 */
export async function getAttachments(
  input: string | null,
  ctx: AttachmentToolUseContext,
  queuedCommands: QueuedCommand[],
  skills: SkillDefinition[] | null,
  options: GetAttachmentsOptions = {},
  externalContext?: AttachmentExternalContext,
  planStateManager?: PlanStateManager,
  messages?: readonly Message[],
): Promise<Attachment[]> {
  const {
    isMainThread = true,
    skipSkillDiscovery = false,
    isInitialTurn = false,
    isTodoToolEnabled = false,
    isTaskUpdateToolEnabled = false,
    skillListingConfig,
    preExpansionInput,
    isTuiPrompt = false,
    suppressWorkflowKeyword = false,
    workflowKeywordTriggerEnabled = true,
    ultracodeActive = false,
    ultracodeRegularUserPrompt = false,
    imagePreparation = {},
    signal,
    diagnostics,
  } = options;
  const results: Attachment[] = [];
  const startedAt = Date.now();
  if (diagnostics?.sessionId) {
    emitSessionPhaseStarted({
      sessionId: diagnostics.sessionId,
      phase: 'input.attachments.collect',
      data: {
        turn_id: diagnostics.turnId,
        loop_id: diagnostics.loopId,
        attachment_phase: diagnostics.phase,
        has_input: input !== null,
        is_main_thread: isMainThread,
        is_initial_turn: isInitialTurn,
      },
    });
  }

  // ── Layer 1: User input attachments (sequential, must run first) ──
  // @file mentions update readFileState which Layer 2 uses for dedup.

  /**
   * The peer-mention pass, bound to Layer 1's finished output.
   *
   * Deferred to Layer 2 rather than awaited here, because it is the one Layer-1
   * task whose cost is I/O nobody is waiting on: a registry read plus a
   * 250 ms-capped connect per peer. Running it inline made that additive on
   * every human TUI turn; running it alongside changed-files and skills hides
   * it behind work already in flight.
   *
   * Precedence is unaffected. The closure captures `atMentions` and
   * `agentMentions` *after* both have resolved, so the peer parser still sees
   * the complete set of tokens the earlier passes claimed — Layer 2 runs after
   * Layer 1, and only its own tasks run concurrently with each other.
   */
  let peerMentionPass: (() => Promise<Attachment[]>) | undefined;

  if (input !== null) {
    const agentMentions = processAgentMentions(input, externalContext);
    const agentNames = new Set(agentMentions.map((a) => a.agentType));
    const [atMentions, mcpResources] = await Promise.all([
      withTimeout(
        'processAtMentionedFiles',
        () => processAtMentionedFiles(input, ctx, agentNames, signal),
        ATTACHMENT_TIMEOUT_MS,
        diagnostics,
      ),
      // MCP timeouts are per resource, preserving other successes.
      processMcpResourceMentions(input, externalContext, signal),
    ]);
    results.push(...atMentions, ...agentMentions, ...mcpResources);

    if (isTuiPrompt) {
      const mentionText = input;
      const claimed = [...atMentions, ...agentMentions];
      peerMentionPass = () =>
        processPeerMentions(mentionText, ctx.cwd, claimed);
    }
  }

  // ── Inter-turn path: inject plan_mode reminder between tool rounds ──
  // input === null means this is called from agent-loop after a tool round.
  if (input === null) {
    const justEntered = ctx.planModeJustEntered ?? false;
    ctx.planModeJustEntered = false;

    const justExited = ctx.planModeJustExited ?? false;
    ctx.planModeJustExited = false;

    if (justExited) {
      // Inject plan_mode_exit immediately so the model knows it can start coding
      // without waiting for the next human turn. Also disarm the planStateManager
      // exit flag so the human-turn path doesn't emit a second plan_mode_exit.
      if (planStateManager) {
        planStateManager.consumeExitAttachmentFlag();
      }
      const planFilePath = ctx.currentPlanFilePath ?? '';
      results.push(
        new PlanModeExitAttachment({
          type: 'plan_mode_exit' as const,
          planFilePath,
          // Performance trade-off: assume the plan file exists when we have a path,
          // since it was just written by the model during plan mode. This avoids a
          // fileExistsSync() call on the inter-turn hot path. The human-turn path
          // (getPlanModeExitAttachment) performs a real filesystem check.
          planExists: planFilePath.length > 0,
        }),
      );
    } else {
      // Emit at most one inter-turn plan reminder per assistant turn.
      const alreadyEmitted = ctx.interTurnSparseEmittedThisTurn ?? false;
      if (!alreadyEmitted) {
        const isPlanActive = planStateManager?.isActive ?? false;
        const interTurnAttachments = getPlanModeInterTurnAttachment(
          isPlanActive,
          ctx.isMainAgent,
          ctx.currentPlanFilePath,
          justEntered,
          // Only resolve the policy-filtered listing when the reminder will
          // actually be emitted — the generator returns [] otherwise.
          isPlanActive
            ? getAvailableAgentTypeNames(externalContext)
            : undefined,
        );
        // Only set the guard flag when we actually emitted something.
        // getPlanModeInterTurnAttachment returns [] when not in plan mode,
        // and setting the flag on an empty return would block a later
        // emission after EnterPlanMode runs mid-turn.
        if (interTurnAttachments.length > 0) {
          ctx.interTurnSparseEmittedThisTurn = true;
        }
        results.push(...interTurnAttachments);
      }
    }
  } else {
    // Human-turn boundary: clear flags that are only meaningful mid-turn.
    // Handles the edge case where enter/exit_plan_mode was the last tool call
    // in a turn — no inter-turn injection ran to consume the flag.
    ctx.planModeJustEntered = false;
    ctx.planModeJustExited = false;
    ctx.interTurnSparseEmittedThisTurn = false;
  }

  // ── Layer 2: Thread-safe attachments (parallel) ──

  // Plan generators only run on human turns (input !== null) and when
  // planStateManager is provided. Inter-turn plan reminders use the
  // lightweight getPlanModeInterTurnAttachment() path above.
  const shouldRunPlanGenerators = input !== null && !!planStateManager;

  // Seed static memory paths for JIT dedup before async generators run.
  seedStaticMemoryPaths(ctx, externalContext);

  // ── JIT AGENTS.md discovery for @-mentioned file paths ──
  // MUST run AFTER seedStaticMemoryPaths and BEFORE Layer 2's
  // getRelevantMemoriesAttachments. Otherwise the first-turn seed would
  // absorb the just-discovered JIT path into loadedNestedMemoryPaths and
  // cause the relevant_memories generator to suppress it.
  // Aligned with CC: only Read tool and @-mentions trigger JIT discovery.
  const mgr = externalContext?.memoryContextManager;
  if (mgr?.discoverContext && input !== null) {
    // Only successfully resolved files can trigger nested memory discovery.
    const mentionedPaths = [
      ...new Set(
        results.flatMap((a) =>
          'filename' in a
            ? [a.filename]
            : a.type === 'directory'
              ? [a.path]
              : [],
        ),
      ),
    ];
    if (mentionedPaths.length > 0) {
      await Promise.allSettled(
        mentionedPaths.map((p) => mgr.discoverContext!(p, [ctx.cwd])),
      );
    }
  }

  // Queued commands are durable user input, not optional ambient context.
  // Start their image work alongside the other generators, but do not subject
  // it to ATTACHMENT_TIMEOUT_MS below: timing it out would return no attachment
  // while agent-loop still consumes the queued command.
  const queuedCommandAttachmentsPromise = buildQueuedCommandAttachments(
    queuedCommands,
    {
      agentId: ctx.agentId,
      isMainAgent: ctx.isMainAgent,
      imagePreparation: { config: ctx.config, ...imagePreparation, failureMode: 'throw' },
      signal,
    },
  );

  const planModePromise: Promise<Attachment[]> = shouldRunPlanGenerators
    ? Promise.resolve(
        (() => {
          const reentry = getPlanModeReentryAttachment(
            ctx,
            externalContext,
            planStateManager,
          );
          if (reentry.length > 0) return reentry;
          return getPlanModeAttachments(
            ctx,
            externalContext,
            planStateManager,
            messages,
          );
        })(),
      )
    : Promise.resolve([]);

  // Re-announcements deferred by a mid-tool compaction. Drained on the first
  // pass of either kind, because a cancelled tool skips the continuation and
  // goes straight to the next human turn. On a human turn the plan generator
  // owns the plan_mode reminder, so a queued copy is dropped when it emitted.
  const deferredPostCompactDeltas =
    drainPendingPostCompactDeltaAttachments(ctx);
  const deferredPostCompactDeltasPromise = planModePromise.then((planMode) =>
    planMode.length > 0
      ? deferredPostCompactDeltas.filter((a) => a.type !== 'plan_mode')
      : deferredPostCompactDeltas,
  );

  const layer2Promises: Array<Promise<Attachment[]>> = [
    // Peer @-mentions. First in the array so the attachment keeps the position
    // it had when this ran inline — directly after Layer 1's own output.
    // `withTimeout` is a stall backstop, not the cost bound; that is the
    // per-probe budget inside listAllPeers().
    ...(peerMentionPass
      ? [
          withTimeout(
            'processPeerMentions',
            peerMentionPass,
            ATTACHMENT_TIMEOUT_MS,
            diagnostics,
          ),
        ]
      : []),

    // Ahead of the generators so fresh deltas follow the re-announced baseline.
    deferredPostCompactDeltasPromise,

    // Changed files (external modifications since last read)
    maybe(
      'getChangedFiles',
      async () => getChangedFiles(ctx),
      diagnostics,
    ),

    // Skill listing (delta-based)
    !skipSkillDiscovery && skills !== null
      ? maybe(
          'getSkillListingAttachments',
          () =>
            getSkillListingAttachments(
              ctx,
              skills,
              isInitialTurn,
              skillListingConfig,
            ),
          diagnostics,
        )
      : Promise.resolve([]),

    // Environment changes on both human turns and tool continuations.
    maybe(
      'getEnvironmentAttachments',
      () => getEnvironmentAttachments(ctx, messages),
      diagnostics,
    ),

    // Date change detection
    maybe(
      'getDateChangeAttachments',
      () => getDateChangeAttachments(ctx, messages),
      diagnostics,
    ),

    // Queued commands for this agent (async: resizes and uploads images)
    queuedCommandAttachmentsPromise,

    // Memory: newly discovered JIT memory files (delta by path set)
    maybe(
      'getRelevantMemoriesAttachments',
      () => getRelevantMemoriesAttachments(ctx, externalContext),
      diagnostics,
    ),

    // Plan mode: periodic throttled reminder OR one-shot reentry notification — human-turn only.
    // Inter-turn plan reminders are handled by getPlanModeInterTurnAttachment().
    // Reentry and normal plan_mode are mutually exclusive: if reentry fires, skip the
    // periodic reminder (plan_mode_reentry already contains all necessary context).
    planModePromise,

    // Plan mode: one-shot exit notification — human-turn only.
    shouldRunPlanGenerators
      ? Promise.resolve(
          getPlanModeExitAttachment(ctx, externalContext, planStateManager),
        )
      : Promise.resolve([]),

    // Verify plan reminder: every 10 turns post plan-mode exit — human-turn only.
    shouldRunPlanGenerators
      ? Promise.resolve(getVerifyPlanReminderAttachment(planStateManager))
      : Promise.resolve([]),

    // Auto mode: periodic throttled reminder — human-turn only. Auto mode has no
    // confirmation dialog, so this is the only thing left telling the model it is
    // running unattended.
    input !== null && isMainThread
      ? Promise.resolve(
          getAutoModeAttachments(ctx.permission?.getPermissionMode(), messages),
        )
      : Promise.resolve([]),

    // Auto mode: one-shot exit notification — human-turn only.
    input !== null && isMainThread
      ? Promise.resolve(
          getAutoModeExitAttachment(
            ctx.config?.permission?.autoClassifier,
            ctx.permission?.getSessionId(),
            ctx.permission?.getPermissionMode(),
          ),
        )
      : Promise.resolve([]),

    // UltraCode session reminders are explicitly enabled by the primary
    // CLI/headless input path. They are never inferred from transport text.
    input !== null && ultracodeRegularUserPrompt
      ? Promise.resolve(getUltraEffortAttachments(ultracodeActive, messages))
      : Promise.resolve([]),

    // Goal state reminder — main thread only, on BOTH human turns and
    // inter-turn (input === null) rounds. The goal loop advances almost
    // entirely through non-human turns driven by the Stop hook, so gating this
    // on human turns would hide the turn budget for the whole loop. Injected
    // here (message layer) instead of the system prompt so the per-turn
    // counter never invalidates the prompt cache.
    isMainThread
      ? Promise.resolve(getGoalStateAttachment(ctx.config))
      : Promise.resolve([]),

    // Hook outputs (queue drain — synchronous)
    Promise.resolve(drainHookOutputAttachments(ctx)),

    // Team context (delta by hash)
    maybe(
      'getTeamContextAttachment',
      () => getTeamContextAttachment(ctx, externalContext),
      diagnostics,
    ),

    // Post-compact deferred injection (tool-tail scenario).
    // When compaction fires while a tool_use is pending (hasPendingToolTail),
    // recovery attachments are queued on ctx rather than injected synchronously.
    // Drained here on the first inter-turn pass after the tool_result arrives.
    Promise.resolve(
      input === null
        ? [
            ...drainPostCompactRestoreAttachments(ctx),
            ...drainPostCompactPlanAttachment(ctx),
          ]
        : [],
    ),

    // MCP instructions delta (delta by server name set)
    Promise.resolve(getMcpInstructionsDeltaAttachments(ctx, externalContext)),

    // Lazy MCP loading: full catalog once, then only tool additions/removals.
    // Kept outside the cacheable prefix so catalog changes do not break the
    // prompt cache.
    Promise.resolve(getLazyMcpReminderAttachments(ctx, externalContext)),

    // Agent listing delta (initial full list + incremental add/remove)
    Promise.resolve(getAgentListingDeltaAttachments(ctx, externalContext)),

    // Workflow opt-in reminder: only when a local TUI prompt contains the
    // standalone UltraCode keyword and the Workflow tool is enabled this turn.
    isTuiPrompt && workflowKeywordTriggerEnabled && !suppressWorkflowKeyword
      ? Promise.resolve(
          getWorkflowKeywordReminderAttachments(
            preExpansionInput === undefined ? input : preExpansionInput,
            externalContext,
          ),
        )
      : Promise.resolve([]),

    // Todo reminder: throttled injection when write_todos hasn't been called
    // recently. Fires on both human-turn boundaries (input !== null) and
    // inter-turn boundaries (input === null) so compaction-resume sessions
    // are covered even when the first assistant turn is in agent-loop.
    Promise.resolve(
      getTodoReminderAttachments(
        messages,
        isTodoToolEnabled,
        ctx.lastKnownTodos,
      ),
    ),

    // Persistent task state is read from disk so reminders survive
    // compaction, resume, and updates made by another process.
    getTaskReminderAttachments(
      messages,
      options.taskStore,
      isTaskUpdateToolEnabled,
    ),
  ];

  const layer2Results = await Promise.all(
    layer2Promises.map((promise) => {
      if (promise === queuedCommandAttachmentsPromise) {
        return promise;
      }
      return Promise.race([
        promise,
        new Promise<Attachment[]>((resolve) =>
          setTimeout(() => resolve([]), ATTACHMENT_TIMEOUT_MS),
        ),
      ]);
    }),
  );

  for (const layerResult of layer2Results) {
    results.push(...layerResult);
  }

  if (diagnostics?.sessionId) {
    emitSessionPhaseFinished({
      sessionId: diagnostics.sessionId,
      phase: 'input.attachments.collect',
      durationMs: Date.now() - startedAt,
      success: true,
      data: {
        turn_id: diagnostics.turnId,
        loop_id: diagnostics.loopId,
        attachment_phase: diagnostics.phase,
        count: results.length,
      },
    });
  }
  return results;
}

/**
 * Collect all attachment messages for a turn and return them as an array.
 *
 * This is the primary API for the QueryEngine integration.
 */
export async function getAttachmentMessages(
  input: string | null,
  ctx: AttachmentToolUseContext,
  queuedCommands: QueuedCommand[],
  skills: SkillDefinition[] | null,
  options: GetAttachmentsOptions = {},
  externalContext?: AttachmentExternalContext,
  planStateManager?: PlanStateManager,
  messages?: readonly Message[],
): Promise<AttachmentMessage[]> {
  const attachments = await getAttachments(
    input,
    ctx,
    queuedCommands,
    skills,
    options,
    externalContext,
    planStateManager,
    messages,
  );

  return attachments.map(createAttachmentMessage);
}

// ── Helpers ──

/** Bounded concurrency for queued-command image resize/upload. */
const QUEUED_IMAGE_CONCURRENCY = 3;
/** Maximum wall time for all queued-command image work in one drain. */
const QUEUED_IMAGE_PROCESSING_TIMEOUT_MS = 30_000;

interface BuildQueuedCommandAttachmentsOptions {
  agentId?: string;
  isMainAgent?: boolean;
  /** Uses the same internal image preparation hook as normal submission. */
  imagePreparation?: ImagePreparationContext;
  signal?: AbortSignal;
}

/**
 * Convert queued commands into QueuedCommandAttachment objects.
 *
 * Async because images must be resized and uploaded before being sent to the
 * model. TUI images arrive through `pastedContents`, while SDK multimodal
 * messages carry image blocks directly in `prompt`. Both forms must mirror the
 * normal (idle) submit path: otherwise a mid-turn queued image can travel as a
 * multi-megabyte inline base64 block, which the provider gateway rejects with a
 * non-retryable 400 and which then poisons the whole session history.
 *
 * Only returns commands targeted at the current agent (or unaddressed ones).
 */
async function buildQueuedCommandAttachments(
  commands: QueuedCommand[],
  options: BuildQueuedCommandAttachmentsOptions = {},
): Promise<QueuedCommandAttachment[]> {
  const {
    agentId,
    isMainAgent = true,
    imagePreparation = {},
    signal,
  } = options;
  const filtered = commands.filter((cmd) =>
    isMainAgent
      ? cmd.targetAgentId === undefined || cmd.targetAgentId === agentId
      : cmd.targetAgentId === agentId,
  );
  const hasQueuedImages = filtered.some(
    (cmd) =>
      cmd.pastedContents !== undefined || hasBase64ImageBlock(cmd.prompt),
  );
  const imageTimeoutController = hasQueuedImages
    ? new AbortController()
    : undefined;
  const imageTimeout = imageTimeoutController
    ? setTimeout(() => {
        imageTimeoutController.abort(
          new Error(
            `queued image processing timed out after ${QUEUED_IMAGE_PROCESSING_TIMEOUT_MS}ms`,
          ),
        );
      }, QUEUED_IMAGE_PROCESSING_TIMEOUT_MS)
    : undefined;
  imageTimeout?.unref?.();
  const imageProcessingSignal = imageTimeoutController
    ? signal
      ? AbortSignal.any([signal, imageTimeoutController.signal])
      : imageTimeoutController.signal
    : signal;

  const results: QueuedCommandAttachment[] = [];
  try {
    for (const cmd of filtered) {
      // Extract image paste IDs for downstream rendering.
      const imagePasteIds = cmd.pastedContents
        ? Object.keys(cmd.pastedContents)
            .map(Number)
            .filter((id) => !isNaN(id))
        : undefined;

      // Normalize SDK image blocks that bypass the normal idle submit path.
      let prompt: ModelStreamUserContent = cmd.prompt;
      if (!cmd.pastedContents && hasBase64ImageBlock(prompt)) {
        prompt = await buildQueuedSdkPromptBlocks(
          prompt,
          imagePreparation,
          imageProcessingSignal,
          signal,
        );
      }

      // 从 TUI 粘贴内容生成标准图片块。
      if (cmd.pastedContents) {
        const imageBlocks = await buildQueuedImageBlocks(
          cmd.pastedContents,
          imagePreparation,
          imageProcessingSignal,
          signal,
        );
        if (imageBlocks.length > 0) {
          // 合并文本与标准图片块。
          const textValue = typeof cmd.prompt === 'string' ? cmd.prompt : '';
          prompt = [{ type: 'text' as const, text: textValue }, ...imageBlocks];
        }
      }

      results.push(
        new QueuedCommandAttachment({
          type: 'queued_command' as const,
          prompt,
          displaySummary: cmd.displaySummary,
          displayColor: cmd.displayColor,
          source_uuid: cmd.uuid ?? cmd.source_uuid,
          commandMode: cmd.commandMode,
          origin: cmd.origin,
          isMeta: cmd.isMeta,
          ...(cmd.isUserDecision ? { isUserDecision: true } : {}),
          ...(imagePasteIds?.length ? { imagePasteIds } : {}),
        }),
      );
      // A message the user typed mid-turn resets the reply-loop count, the
      // same as one submitted between turns (see input/executor.ts).
      if (
        isMainAgent &&
        cmd.targetAgentId === undefined &&
        cmd.isMeta !== true &&
        !cmd.bridgeOrigin &&
        cmd.commandMode !== 'task-notification' &&
        (cmd.origin === undefined || cmd.origin.kind === 'human')
      ) {
        noteHumanTurn();
      }
    }
    return results;
  } finally {
    if (imageTimeout) {
      clearTimeout(imageTimeout);
    }
  }
}

function hasBase64ImageBlock(
  prompt: ModelStreamUserContent,
): prompt is readonly ModelInputContentBlock[] {
  return (
    typeof prompt !== 'string' &&
    prompt.some(
      (block) => block.type === 'image' && block.source.type === 'base64',
    )
  );
}

/**
 * Normalize inline SDK images embedded in a queued rich prompt.
 *
 * SDK messages do not populate `pastedContents`, so mid-turn commands never
 * pass through `processUserInput()` stage 0. Process each inline image here and
 * preserve the original content-block order. Per-image failures degrade to
 * text so an invalid or failed upload cannot poison the persisted session.
 */
async function buildQueuedSdkPromptBlocks(
  blocks: readonly ModelInputContentBlock[],
  imagePreparation: ImagePreparationContext,
  signal?: AbortSignal,
  parentSignal?: AbortSignal,
): Promise<ModelInputContentBlock[]> {
  let imageOrdinal = 0;
  const indexedBlocks = blocks.map((block) => ({
    block,
    imageOrdinal: block.type === 'image' ? ++imageOrdinal : undefined,
  }));

  return mapWithConcurrency(
    indexedBlocks,
    QUEUED_IMAGE_CONCURRENCY,
    async ({ block, imageOrdinal }): Promise<ModelInputContentBlock> => {
      if (block.type !== 'image' || block.source.type !== 'base64') {
        return block;
      }

      try {
        signal?.throwIfAborted();
        const { block: normalized } = await resizePastedImage(
          {
            id: imageOrdinal!,
            type: 'image',
            content: block.source.data,
            mediaType: block.source.mediaType,
          },
          undefined,
          signal,
          imagePreparation,
        );
        signal?.throwIfAborted();
        return normalized;
      } catch (error) {
        parentSignal?.throwIfAborted();
        const detail = error instanceof Error ? error.message : String(error);
        runLogger.warn(
          `[queued-command] Replacing unprocessable SDK image #${imageOrdinal}: ${detail}`,
        );
        return {
          type: 'text',
          text: `[Image #${imageOrdinal} could not be processed: ${detail}]`,
        };
      }
    },
  );
}

/**
 * Normalize the pasted images of one queued command into API-ready blocks.
 *
 * Runs the same stages as the normal submit path: materialize deferred local
 * paths, enforce the per-request media cap, then resize + upload each image.
 * Internal-provider images must leave as `source.type: 'url'`; falling back to
 * base64 after a failed upload would recreate the poisoned-session failure
 * this path exists to prevent.
 *
 * Per-image failures are isolated: the offending image is replaced by a short
 * text note instead of being emitted as a raw base64 payload, so one bad paste
 * can neither reject the whole attachment batch nor break the request.
 */
async function buildQueuedImageBlocks(
  pastedContents: Record<number, PastedContent>,
  imagePreparation: ImagePreparationContext,
  signal?: AbortSignal,
  parentSignal?: AbortSignal,
): Promise<ModelInputContentBlock[]> {
  let imageEntries = Object.values(pastedContents).filter(
    (content): content is PastedContent & { type: 'image' } =>
      content.type === 'image',
  );
  if (imageEntries.length === 0) {
    return [];
  }

  if (imageEntries.length > API_MAX_MEDIA_PER_REQUEST) {
    runLogger.warn(
      `[queued-command] Too many images (${imageEntries.length}), ` +
        `truncating to ${API_MAX_MEDIA_PER_REQUEST}`,
    );
    imageEntries = imageEntries.slice(0, API_MAX_MEDIA_PER_REQUEST);
  }

  const blocks = await mapWithConcurrency(
    imageEntries,
    QUEUED_IMAGE_CONCURRENCY,
    async (img): Promise<ModelInputContentBlock> => {
      try {
        signal?.throwIfAborted();
        // Resolve each deferred source independently so one missing local file
        // cannot discard every other image in the queued command.
        const materialized = await preparePastedImage(img, signal);
        signal?.throwIfAborted();
        const { block } = await resizePastedImage(
          materialized,
          undefined,
          signal,
          imagePreparation,
        );
        // Preparation failures degrade this queued image to text below.
        signal?.throwIfAborted();
        return block;
      } catch (error) {
        // Parent cancellation must abort the turn and leave queue lifecycle
        // handling to agent-loop; only the local 30-second deadline degrades
        // the remaining images to text so the queued command can continue.
        parentSignal?.throwIfAborted();
        const detail = error instanceof Error ? error.message : String(error);
        runLogger.warn(
          `[queued-command] Replacing unprocessable pasted image #${img.id}: ${detail}`,
        );
        return {
          type: 'text' as const,
          text: `[Image #${img.id} could not be processed: ${detail}]`,
        };
      }
    },
  );

  return blocks;
}

/**
 * Create a ToolUseContext for use with the attachment pipeline.
 *
 * This is a convenience factory. In practice the QueryEngine will
 * maintain a long-lived context and pass it here.
 */
export function createAttachmentContext(
  cwd: string,
  agentId?: string,
  options: { isMainAgent?: boolean; config?: Config } = {},
): AttachmentToolUseContext {
  return {
    config: options.config,
    permission: options.config?.permission,
    fileReadState: createToolFileStateCache(),
    readFileState: createFileStateCacheWithSizeLimit(
      READ_FILE_STATE_CACHE_SIZE,
    ),
    agentId,
    // True when called from the top-level QueryEngine (not a sub-agent).
    // getAgentContext() is only defined inside runWithAgentContext(), which
    // sub-agents set up in local-invocation.ts. The main session never calls it.
    isMainAgent: options.isMainAgent ?? getAgentContext() === undefined,
    cwd,
    isFirstTurnSeedDone: false,
    loadedNestedMemoryPaths: new Set(),
    sentSkillNames: new Map(),
    announcedMcpInstructionServers: new Set(),
    announcedLazyMcpTools: new Set(),
    // Agent listing delta tracking
    announcedAgentTypes: new Set(),
    announcedAgentDescriptions: new Map(),
    seenSessionStartHookOutputs: new Set(),
    // Event queues
    pendingHookOutputs: [],
    pendingHookAttachments: [],
    postCompactCandidates: null,
    postCompactPlanAttachment: null,
    pendingPostCompactDeltaAttachments: null,
  };
}
