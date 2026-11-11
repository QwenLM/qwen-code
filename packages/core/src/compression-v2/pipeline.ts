/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import type { ModelStreamTool } from '../provider/modelStreamRequest.js';
import type { ModelPolicyLabels } from '../core/model-policy.js';

import type { Message } from './message-types.js';
import { getRole } from './message-types.js';
import {
  countRequestTokens,
  type RequestTokenCount,
} from '../utils/request-token-count.js';
import type { NormalizeMessagesForAPIOptions } from '../protocol/provider/request-converter.js';
import { CompressionStatus } from '../core/turn-events.js';
import { findCompressionBoundary } from './boundary.js';
import { runCompressionCleanup } from './cleanup.js';
import {
  compressionV2StateStore,
  type CompressionStateStore,
} from './state-store.js';
import { applyToolResultBudget } from './tool-result-budget.js';
import { createNoopResult, runAutoCompactStage } from './auto-compact.js';
import {
  HookEventName,
  PreCompactTrigger,
  SessionStartSource,
} from '../hooks/types.js';
import { runLogger } from '../utils/runLogger.js';
import { createAttachmentMessage } from '../attachments/factory.js';
import {
  HookOutputAttachment,
  HookSuccessAttachment,
} from '../attachments/types.js';
import type { SessionStateStore } from '../services/session-state-store.js';
import { loadLatestSessionUsage } from '../services/session-state-usage.js';
import type { Config } from '../config/config.js';
import { getSubagentTranscriptPath } from '../services/subagent-transcript.js';
import {
  createAutoCompactTrackingState,
  toPreCompactTrigger,
  type AutoCompactTrackingState,
  type CompressionPipelineInput,
  type CompressionStageContext,
  type CompressionPipelineResult,
  type CompressionPipelineTarget,
  type PartialCompactOptions,
} from './types.js';
import type { SystemPrompt } from '../prompts/types.js';
import { CoreEvent, coreEvents, type CompressionTrigger, type CompressionUsagePayload } from '../utils/events.js';
import { addAnthropicUsage } from '../protocol/provider/usage-converter.js';
import { runPartialForkCompact } from './fork-compact.js';
import { ensureCompactModelSelected } from './compact-model.js';



import { isCancellationError } from '../utils/errors.js';


// ---------------------------------------------------------------------------
// Helper: inject SessionStart hook outputs into post-compact history
// ---------------------------------------------------------------------------
function injectSessionStartHookOutputs(
  sessionStartResult:
    | {
        getAdditionalContext(): string | undefined;
        getStdoutForModel(e: HookEventName): string | undefined;
      }
    | undefined,
  history: Message[],
): void {
  const retainedHooks = history.filter(
    (message) => message.isCompactionPrefix && message.type === 'attachment',
  );
  const retainedOutput = (type: string, content: string) =>
    retainedHooks.some(
      (message) =>
        message.type === 'attachment' &&
        message.attachment.type === type &&
        (type === 'hook_output'
          ? message.attachment['output']
          : message.attachment['content']) === content,
    );
  const ctx = sessionStartResult?.getAdditionalContext();
  if (ctx && !retainedOutput('hook_output', ctx)) {
    const hookAtt: HookOutputAttachment = new HookOutputAttachment({
      type: 'hook_output',
      hookEventName: HookEventName.SessionStart,
      output: ctx,
    });
    history.push(createAttachmentMessage(hookAtt));
  }
  const stdout = sessionStartResult?.getStdoutForModel(
    HookEventName.SessionStart,
  );
  if (stdout && !retainedOutput('hook_success', stdout)) {
    const stdoutAtt: HookSuccessAttachment = new HookSuccessAttachment({
      type: 'hook_success',
      content: stdout,
      hookName: '',
      toolUseID: '',
      hookEvent: HookEventName.SessionStart,
    });
    history.push(createAttachmentMessage(stdoutAtt));
  }
}

interface CompressionPipelineOptions {
  modelProviderManager: ModelProviderManager;
  target: CompressionPipelineTarget;
  sessionScopeId?: string;
  agentId?: string;
}

/** Human-readable reason a compaction did not complete, for progress events. */
function getCompressionFailureReason(
  info: CompressionPipelineResult['info'],
): string {
  if (info.failureReason) {
    return info.failureReason;
  }

  switch (info.compressionStatus) {
    case CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT:
      return 'inflated_token_count';
    case CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR:
      return 'token_count_error';
    case CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY:
      return 'empty_summary';
    case CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED:
      return 'precompact_blocked';
    case CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST:
      return 'model_request_failed';
    default:
      return 'unknown_compression_failure';
  }
}

function stampBoundaryDuration(
  result: CompressionPipelineResult,
  durationMs: number,
): void {
  const boundary = result.newHistory?.[0];
  if (
    boundary?.type === 'system' &&
    boundary.subtype === 'compact_boundary' &&
    boundary.compactMetadata
  ) {
    boundary.compactMetadata.durationMs = durationMs;
  }
}

/**
 * Options for CompressionPipeline.compress().
 */
export interface CompressOptions {
  modelResolution: ModelSelection;
  policyLabels?: ModelPolicyLabels;
  resolveCompactSelection?: CompressionPipelineInput['resolveCompactSelection'];
  promptId: string;
  force: boolean;
  /**
   * Root conversation session ID used by forked model requests. This is
   * intentionally separate from `sessionScopeId`, which may identify a
   * subagent compression scope rather than a real session.
   */
  rootSessionId?: string;
  config: Config;
  systemPrompt?: SystemPrompt;
  tools?: readonly ModelStreamTool[];
  abortSignal?: AbortSignal;
  /** See {@link CompressionPipelineInput.customInstructions}. */
  customInstructions?: string;
  /** Opaque SDK context inherited by compact model requests for this query. */
  customContext?: Readonly<Record<string, string>>;
  /** See {@link CompressionPipelineInput.parentRequestSetId}. */
  parentRequestSetId?: string;
  /** See {@link CompressionPipelineInput.parentBusinessInfo}. */
  parentBusinessInfo?: Readonly<
    import('../qoder/business-info.js').BusinessInfo
  >;
  /** Projection used by the parent request whose size drives compaction. */
  projectionOptions?: NormalizeMessagesForAPIOptions;
  /** Count of the exact parent request, before any history replacement. */
  requestTokenCount?: RequestTokenCount;
  /** Private response usage for resumed/redacted transcripts. */
  sessionStateStore?: SessionStateStore;
  /**
   * How the compaction was initiated.  Defaults to 'auto' when omitted.
   * Pass 'manual' for user-triggered `/compact` calls and 'reactive' for
   * compactions triggered by an API prompt-too-long error.
   */
  trigger?: CompressionTrigger;
  /** Query-scoped breaker state. Omitted by manual/out-of-loop callers. */
  autoCompactTracking?: AutoCompactTrackingState;
  /**
   * When set, runs a partial compaction instead of a full one.
   * Only the slice specified by `partialOptions` is summarized; the rest of
   * the working history is kept verbatim.  Forces `force: true` semantics
   * (threshold is ignored). Uses the fork-compact path.
   */
  partialOptions?: PartialCompactOptions;
  /**
   * Pending user turn that the agent loop is about to send but has NOT
   * appended to the compressible history. The ordered bundle includes the
   * user message and its input attachments. It is included ONLY in the
   * threshold token-count estimate — it is NOT added to `compressible` and
   * never reaches the fork-compact summarizer or post-compact history.
   */
  pendingTurnForThreshold?: readonly Message[];
  /**
   * Exact ephemeral runtime messages prepended to the parent provider request,
   * such as frozen startup memory. The same prefix is used for threshold
   * accounting and cache-aligned fork projection, while remaining outside the
   * history that is summarized or persisted.
   */
  requestPrefixMessages?: readonly Message[];
}

function historiesMatch(
  left: readonly Message[],
  right: readonly Message[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((message, index) => message === right[index]);
}

export class CompressionPipeline {
  private readonly stateStore: CompressionStateStore;
  constructor(
    private readonly options: CompressionPipelineOptions,
    stateStore: CompressionStateStore = compressionV2StateStore,
  ) {
    this.stateStore = stateStore;
  }

  /**
   * Run the multi-stage compression pipeline on the given message history.
   *
   * Accepts the full runtime `Message[]` (the discriminated union from
   * `protocol/transcript/message.ts`).  Only `user` and `assistant` messages
   * participate in compression; other variants are filtered out at entry.
   *
   * Stages (in order):
   *   1. Boundary detection — locate compact_boundary marker
   *   2. Tool-result budget — enforce per-message character budget on tool responses
   *   3. Auto-compact — threshold checks and fork summarization
   *   4. Cleanup — failure tracking and state persistence
   *   5. Successful compaction — PostCompact and SessionStart hooks
   */
  async compress(
    history: readonly Message[],
    inputOptions: CompressOptions,
  ): Promise<CompressionPipelineResult> {
    const compressionTrigger: CompressionTrigger =
      inputOptions.trigger ?? (inputOptions.force ? 'manual' : 'auto');
    const compressionStartedAt = Date.now();
    const options = { ...inputOptions };

    return (async () => {

        let result: CompressionPipelineResult;
        let compactUsage: CompressionUsagePayload | undefined;
        const recordUsage = (next: CompressionUsagePayload) => {
          if (!compactUsage) {
            compactUsage = next;
            return;
          }
          const credits = compactUsage.usage.credits;
          const nextCredits = next.usage.credits;
          compactUsage = {
            ...compactUsage,
            modelRequestIds: [
              ...new Set([...compactUsage.modelRequestIds, ...next.modelRequestIds]),
            ],
            usage: {
              ...addAnthropicUsage(compactUsage.usage, next.usage),
              ...(credits !== undefined || nextCredits !== undefined
                ? { credits: (credits ?? 0) + (nextCredits ?? 0) }
                : {}),
            },
          };
        };
        try {
          result = await this.compressImpl(history, options, recordUsage);
        } catch (error) {
          if (compactUsage) {
            coreEvents.emit(CoreEvent.CompressionUsage, compactUsage);
          }
          if (isCancellationError(error, options.abortSignal)) {
            coreEvents.emitCompressionProgress({
              stage: 'failed',
              trigger: compressionTrigger,
              sessionId: options.rootSessionId ?? options.config.getSessionId(),
              sessionScopeId:
                this.options.sessionScopeId ??
                options.rootSessionId ??
                options.config.getSessionId(),
              target: this.options.target,
              agentId: this.options.agentId,
              failureReason: 'cancelled',
            });
          }
          throw error;
        }
        stampBoundaryDuration(result, Date.now() - compressionStartedAt);
        if (compactUsage) {
          const boundary = result.newHistory?.[0];
          if (
            result.info.compressionStatus === CompressionStatus.COMPRESSED &&
            boundary?.type === 'system' &&
            boundary.subtype === 'compact_boundary'
          ) {
            boundary.compactUsage = compactUsage.usage;
            boundary.modelRequestIds = compactUsage.modelRequestIds;
            boundary.agentId = compactUsage.agentId;
          } else {
            coreEvents.emit(CoreEvent.CompressionUsage, compactUsage);
          }
        }

        return result;
      })();
  }

  private async compressImpl(
    history: readonly Message[],
    options: CompressOptions,
    onCompactUsage: NonNullable<CompressionPipelineInput['onCompactUsage']>,
  ): Promise<CompressionPipelineResult> {
    const { promptId, force, config, systemPrompt, tools, abortSignal } =
      options;

    const compressionTrigger: CompressionTrigger =
      options.trigger ?? (force ? 'manual' : 'auto');
    const autoCompactTracking =
      options.autoCompactTracking ?? createAutoCompactTrackingState();

    // Locate the boundary on the FULL unfiltered history first — the
    // `system/compact_boundary` marker emitted by a prior compaction lives
    // on as a system message that the user/assistant filter would drop.
    // After the boundary is anchored, `boundary.contents` is already
    // restricted to compressible (user/assistant) messages.
    const boundary = findCompressionBoundary(history);

    const compressible = boundary.contents;

    const hasModelTurn = compressible.some(
      (msg) => getRole(msg) === 'assistant',
    );
    if (!hasModelTurn) {
      return createNoopResult(CompressionStatus.NOOP, 0);
    }

    // The pending turn is NOT part of `compressible` — the agent loop excludes
    // it via getRequestBaseHistory so the fork-compact summarizer doesn't fold
    // an unsent prompt or its input attachments into the summary. The complete
    // turn is about to be sent in the next API request, so every message in it
    // must count toward the auto-compact threshold.
    const historyForThreshold: readonly Message[] = [
      ...(options.requestPrefixMessages ?? []),
      ...boundary.prefixContents,
      ...compressible,
      ...(options.pendingTurnForThreshold ?? []),
    ];
    const requestTokenInput = {
      model: options.modelResolution.model.key,
      systemPrompt,
      tools,
      projectionOptions: options.projectionOptions,
      latestUsage: options.requestTokenCount
        ? undefined
        : await loadLatestSessionUsage(options.sessionStateStore).catch(
            () => null,
          ),
    };
    const initialTokenCount =
      options.requestTokenCount ??
      countRequestTokens({
        ...requestTokenInput,
        messages: historyForThreshold,
      });
    const promptTokenCount = initialTokenCount.tokens;
    const promptTokenAnchored = initialTokenCount.source === 'usage';

    const rootSessionId = options.rootSessionId ?? config.getSessionId();
    const sessionScopeId = this.options.sessionScopeId ?? rootSessionId;
    // 历史会话可能保留在旧 bucket；压缩回查必须与实际 Writer 一致。
    const sessionTranscriptPath = config.getActiveSessionTranscriptPath();
    const transcriptPath =
      this.options.target === 'main'
        ? sessionTranscriptPath
        : this.options.agentId
          ? getSubagentTranscriptPath(
              { sessionTranscriptPath },
              rootSessionId,
              this.options.agentId,
            )
          : undefined;


    /** 组装阶段的统一入参 */
    const input: CompressionPipelineInput = {
      modelResolution: options.modelResolution,
      policyLabels: options.policyLabels,
      resolveCompactSelection: options.resolveCompactSelection,
      modelProviderManager: this.options.modelProviderManager,
      history: compressible,
      requestPrefixMessages: options.requestPrefixMessages ?? [],
      promptTokenCount,
      promptTokenSource: promptTokenAnchored ? 'usage' : 'estimate',
      systemPrompt,
      tools,
      ...(options.customContext !== undefined
        ? { customContext: options.customContext }
        : {}),
      promptId,
      force,
      trigger: compressionTrigger,
      autoCompactTracking,
      onCompactUsage,
      config,
      abortSignal,
      target: this.options.target,
      rootSessionId,
      sessionScopeId,
      agentId: this.options.agentId,
      customInstructions: options.customInstructions,
      transcriptPath,
      parentRequestSetId: options.parentRequestSetId,
      parentBusinessInfo: options.parentBusinessInfo,
    };

    const state = this.stateStore.getState(config, input.sessionScopeId);

    // ---------------------------------------------------------------------------
    // Partial compact short-circuit
    // ---------------------------------------------------------------------------
    // When `partialOptions` is supplied, bypass the normal threshold/session-
    // memory path and delegate directly to runPartialForkCompact.  Partial
    // compact is always a manual operation so we don't emit 'starting' for
    // the threshold-check path.
    /** 局部压缩，没有传递开启的位置 */
    if (options.partialOptions) {
      const partialContext = {
        input: { ...input, force: true, trigger: 'manual' as const },
        state,
        boundary,
        fullHistory: compressible,
        workingHistory: compressible,
      };
      coreEvents.emitCompressionProgress({
        stage: 'starting',
        trigger: 'manual',
        sessionId: rootSessionId,
        sessionScopeId,
        target: this.options.target,
        agentId: this.options.agentId,
        tokensBeforeCompact: promptTokenCount,
      });

      await ensureCompactModelSelected(partialContext.input);
      const preCompactResult = await config
        .getHookSystem?.()
        ?.firePreCompactEvent(
          PreCompactTrigger.Manual,
          partialContext.input.customInstructions ?? '',
          undefined,
          partialContext.input.modelResolution.model.key,
        );
      if (
        preCompactResult?.finalOutput?.shouldStopExecution?.() ||
        preCompactResult?.finalOutput?.isBlockingDecision?.()
      ) {
        const blockReason =
          preCompactResult.finalOutput.getEffectiveReason() ||
          'Blocked by PreCompact hook';
        coreEvents.emitCompressionProgress({
          stage: 'failed',
          trigger: 'manual',
          sessionId: rootSessionId,
          sessionScopeId,
          target: this.options.target,
          agentId: this.options.agentId,
          tokensBeforeCompact: promptTokenCount,
          failureReason: blockReason,
        });
        return createNoopResult(
          CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
          promptTokenCount,
          blockReason,
        );
      }
      const preCompactAdditionalContext =
        preCompactResult?.finalOutput?.getAdditionalContext?.() ??
        preCompactResult?.finalOutput?.getStdoutContent?.();
      if (preCompactAdditionalContext) {
        partialContext.input.customInstructions = partialContext.input
          .customInstructions
          ? `${
              partialContext.input.customInstructions
            }\n${preCompactAdditionalContext}`
          : preCompactAdditionalContext;
      }

      const partialResult = await runPartialForkCompact(
        partialContext,
        options.partialOptions,
      );
      partialResult.hookModel = partialContext.input.modelResolution.model.key;

      await runCompressionCleanup(partialResult, partialContext);
      this.stateStore.saveState(config, sessionScopeId);

      if (
        partialResult.info.compressionStatus === CompressionStatus.COMPRESSED
      ) {
        coreEvents.emitCompressionProgress({
          stage: 'done',
          trigger: 'manual',
          sessionId: rootSessionId,
          sessionScopeId,
          target: this.options.target,
          agentId: this.options.agentId,
          tokensBeforeCompact: promptTokenCount,
          tokensAfterCompact: partialResult.info.newTokenCount,
        });
        const hookSystem = config.getHookSystem?.();
        if (hookSystem) {
          await hookSystem.firePostCompactEvent(
            PreCompactTrigger.Manual,
            partialResult.compactSummary ?? '',
            undefined,
            partialResult.hookModel,
          );
          const sessionStartResult = await hookSystem.fireSessionStartEvent(
            SessionStartSource.Compact,
            options.modelResolution.model.key,
          );
          if (sessionStartResult?.shouldStopExecution()) {
            runLogger.warn(
              'SessionStart(Compact) hook requested stop, but compaction already completed',
            );
          }
          if (partialResult.newHistory) {
            injectSessionStartHookOutputs(
              sessionStartResult,
              partialResult.newHistory,
            );
          }
        }
      } else {
        coreEvents.emitCompressionProgress({
          stage: 'failed',
          trigger: 'manual',
          sessionId: rootSessionId,
          sessionScopeId,
          target: this.options.target,
          agentId: this.options.agentId,
          tokensBeforeCompact: promptTokenCount,
          failureReason: getCompressionFailureReason(partialResult.info),
          providerStatus: partialResult.info.providerStatus,
          providerSource: partialResult.info.providerSource,
          ...(partialResult.info.displayErrorCode !== undefined && {
            displayErrorCode: partialResult.info.displayErrorCode,
          }),
          ...(partialResult.info.errorFallbackMessage !== undefined && {
            errorFallbackMessage: partialResult.info.errorFallbackMessage,
          }),
        });
      }

      return partialResult;
    }

    /** 正常压缩流水线开始 */
    const initialContext = {
      input,
      state,
      boundary,
      fullHistory: compressible,
      workingHistory: compressible,
    };
    /**
     * type='user' 消息中的 tool_result，超过 200K 字符，替换成路径预览，
     */
    const budgetedHistory = await applyToolResultBudget(
      initialContext.workingHistory,
      initialContext,
    );

    const persistentStagedHistory = [
      ...boundary.prefixContents,
      ...budgetedHistory,
    ];
    const persistentStagedHistoryChanged = !historiesMatch(
      budgetedHistory,
      compressible,
    );

    // Budget replacements invalidate the old usage anchor. Count the complete
    // next request, including attachments, pending input and fixed overhead.
    const stagedTokenCount = persistentStagedHistoryChanged
      ? countRequestTokens({
          ...requestTokenInput,
          messages: [
            ...(options.requestPrefixMessages ?? []),
            ...persistentStagedHistory,
            ...(options.pendingTurnForThreshold ?? []),
          ],
        })
      : initialTokenCount;
    const requestPromptTokenCount = stagedTokenCount.tokens;
    const autoCompactContext: CompressionStageContext = {
      ...initialContext,
      input: {
        ...input,
        history: persistentStagedHistory,
        promptTokenCount: requestPromptTokenCount,
        promptTokenSource:
          stagedTokenCount.source === 'usage'
            ? 'usage'
            : persistentStagedHistoryChanged
              ? 'staged-estimate'
              : 'estimate',
      },
      workingHistory: budgetedHistory,
    };
    const compactedResult = await runAutoCompactStage(autoCompactContext);
    const baseResult: CompressionPipelineResult =
      persistentStagedHistoryChanged && compactedResult.newHistory === null
        ? { newHistory: persistentStagedHistory, info: compactedResult.info }
        : compactedResult;

    // Post-compact restore is a no-op pass-through; real restore work is
    // done by finalizePostCompact() in post-compact-finalize.ts via the
    // onCompressionCompleted hook.
    const restoredResult = baseResult;

    await runCompressionCleanup(restoredResult, {
      ...initialContext,
      workingHistory: budgetedHistory,
    });

    // Emit compression progress: done or failed.
    if (
      restoredResult.info.compressionStatus === CompressionStatus.COMPRESSED
    ) {
      coreEvents.emitCompressionProgress({
        stage: 'done',
        trigger: compressionTrigger,
        sessionId: rootSessionId,
        sessionScopeId,
        target: this.options.target,
        agentId: this.options.agentId,
        tokensBeforeCompact: requestPromptTokenCount,
        tokensAfterCompact: restoredResult.info.newTokenCount,
      });
    } else if (
      restoredResult.info.compressionStatus !== CompressionStatus.NOOP
    ) {
      coreEvents.emitCompressionProgress({
        stage: 'failed',
        trigger: compressionTrigger,
        sessionId: rootSessionId,
        sessionScopeId,
        target: this.options.target,
        agentId: this.options.agentId,
        tokensBeforeCompact: requestPromptTokenCount,
        failureReason: getCompressionFailureReason(restoredResult.info),
        providerStatus: restoredResult.info.providerStatus,
        providerSource: restoredResult.info.providerSource,
        ...(restoredResult.info.displayErrorCode !== undefined && {
          displayErrorCode: restoredResult.info.displayErrorCode,
        }),
        ...(restoredResult.info.errorFallbackMessage !== undefined && {
          errorFallbackMessage: restoredResult.info.errorFallbackMessage,
        }),
      });
    }

    // Boundary anchoring is now driven by the `system/compact_boundary`
    // marker that `buildPostCompactHistory` prepends to `newHistory` and
    // that downstream callers persist into the JSONL transcript. There is
    // no sidecar fingerprint to write here.
    this.stateStore.saveState(config, input.sessionScopeId);

    /** 压缩成功后清理
     * 1. cleanup
     * 2. 成功埋点和done 事件
     * 3/ 流水线状态
     * 4. postCompact hook 执行
     * 5. sessionStart hook 执行：注入用户定义的上下文，避免被压缩丢失
     * 6. Hook 输出注入 newHistory
     */
    if (
      restoredResult.info.compressionStatus === CompressionStatus.COMPRESSED
    ) {
      const trigger = toPreCompactTrigger(compressionTrigger);
      const hookSystem = config.getHookSystem?.();

      if (hookSystem) {
        await hookSystem.firePostCompactEvent(
          trigger,
          restoredResult.compactSummary ?? '',
          undefined,
          restoredResult.hookModel,
        );
        const sessionStartResult = await hookSystem.fireSessionStartEvent(
          SessionStartSource.Compact,
          options.modelResolution.model.key,
        );
        if (sessionStartResult?.shouldStopExecution()) {
          runLogger.warn(
            'SessionStart(Compact) hook requested stop, but compaction already completed',
          );
        }
        if (restoredResult.newHistory) {
          injectSessionStartHookOutputs(
            sessionStartResult,
            restoredResult.newHistory,
          );
        }
      }
    }

    /** 返回结果 */
    return restoredResult;
  }
}
