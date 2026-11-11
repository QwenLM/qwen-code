/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CustomProviderAccessError } from '../config/custom-provider-access.js';
import { collectErrorChain } from '../utils/errors.js';

/**
 * @fileoverview Fork 摘要压缩：准备请求、处理请求异常、提取摘要并构造候选历史。
 *
 * 阅读顺序：runForkCompact → buildCompactionExecutor →
 * runCompactionRequest → 历史组装与 Token 校验。
 * 本文件不判断自动压缩阈值，不更新自动失败次数，也不执行压缩前后 Hook；
 * 这些职责分别由 auto-compact.ts、cleanup.ts 和 pipeline.ts 承担。
 */
import {
  CompressionStatus,
  type ChatCompressionInfo,
} from '../core/turn-events.js';
import {
  type Message,
  estimateBlocksTokenCount,
  getContentBlocks,
} from './message-types.js';
import { runLogger } from '../utils/runLogger.js';
import type {
  CompactionFailureReason,
  CompressionPipelineResult,
  CompressionStageContext,
  PartialCompactOptions,
  SummaryParseReason,
} from './types.js';
import { toCompactMetadataTrigger } from './types.js';
import {
  extractAndFormatSummary,
  getOriginalTokenCount,
  buildPostCompactHistory,
  buildPartialCompactHistory,
  buildCompactDirective,
  setBoundaryPostTokens,
  sliceHistoryForPartialCompact,
} from './compact-utils.js';
import { runForkedAgent } from '../core/forkedAgent.js';
import { ensureCompactModelSelected } from './compact-model.js';
import { retainCompactionPrefix } from './compaction-prefix.js';
import {
  canPreserveResponseGroup,
  splitForCompaction,
} from './response-groups.js';
import { buildForkContextMessagesFromPrefix } from '../utils/forkContextUtils.js';
import { buildModelProjectionOptions } from '../utils/modelProjectionOptions.js';
import { wrapWithParentToolSchemas } from '../agents/fork-subagent.js';
import {
  hasStructuredMediaTooLargeDetails,
  isPromptTooLongError,
  withPtlRetry,
  type PtlRetryOptions,
} from './ptl-retry.js';
import { coreEvents } from '../utils/events.js';
import { getForkCompletionBilling } from '../model-request/credit-usage.js';
import { getRequestCredits } from '../services/session-state-usage.js';
import {
  isRecord,
  readString,
  readFiniteNumber,
} from '../protocol/provider/qoder-api-error.js';
import {
  getResultErrorCode,
  isTerminalQuotaResultErrorCode,
  RESULT_ERROR_CODES,
} from '../utils/resultErrorCode.js';
import {
  collectErrorCodes,
  collectErrorMessages,
  isAbortErrorDeep,
  isCancellationError,
} from '../utils/errors.js';
import { getApiErrorDisplayMetadata } from '../utils/errorParsing.js';
import { FETCH_FAILED_MESSAGE } from '../utils/retry.js';
import { stripInlineDataForCompaction } from './strip-inline-data.js';
import { findEmptyAssistantCompletionError } from '../model-request/empty-assistant-completion.js';
import { findModelInferenceError } from '../provider/modelInferenceError.js';
import { QODER_PROVIDER_ID } from '../provider/modelProvider.js';

/** Node/undici socket-level codes that indicate a network failure. */
const NETWORK_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

type CompactionRequestFailureInfo = Pick<
  ChatCompressionInfo,
  | 'failureReason'
  | 'providerStatus'
  | 'errorCode'
  | 'displayErrorCode'
  | 'errorFallbackMessage'
  | 'providerSource'
>;

/**
 * 将摘要请求异常归一化为失败原因及展示元数据，不在此处重试或设置阻断状态。
 * 按取消、媒体、超窗、额度、认证、排队、限流、服务端、网络、本地错误的顺序匹配。
 * cleanup.ts 后续使用 failureReason 决定自动压缩计数或硬阻断。
 * @param error 请求执行阶段抛出的异常。
 * @returns 失败分类、可用的 HTTP 状态和错误码，以及用户展示信息。
 */
function classifyCompactionRequestError(
  error: unknown,
  providerSource: string,
): CompactionRequestFailureInfo {
  const errorRecord = isRecord(error) ? error : {};
  const inferenceError = findModelInferenceError(error);
  const providerStatus =
    inferenceError?.status ??
    readFiniteNumber(errorRecord['httpStatus']) ??
    readFiniteNumber(errorRecord['status']);
  const resultErrorCode = getResultErrorCode(error);
  // A third-party business code can collide with a Qoder result code.
  const canInterpretQoderCodes =
    !inferenceError || providerSource === QODER_PROVIDER_ID;
  const qoderResultCode = canInterpretQoderCodes ? resultErrorCode : undefined;
  const transportCode = canInterpretQoderCodes
    ? readString(errorRecord['code'])
    : undefined;
  const displayMetadata = getApiErrorDisplayMetadata(error);
  const displayErrorCode = inferenceError
    ? inferenceError.code
    : (displayMetadata?.displayErrorCode ??
      (resultErrorCode === RESULT_ERROR_CODES.sensitiveContent
        ? RESULT_ERROR_CODES.sensitiveContent
        : undefined));
  const errorFallbackMessage =
    !inferenceError && displayErrorCode !== undefined
      ? displayMetadata?.fallbackMessage.trim() ||
        (error instanceof Error ? error.message.trim() : '')
      : '';
  const errorCode = inferenceError
    ? inferenceError.code
    : ((resultErrorCode !== undefined ? String(resultErrorCode) : undefined) ??
      transportCode ??
      (displayErrorCode !== undefined ? String(displayErrorCode) : undefined));

  const emptyCompletion = findEmptyAssistantCompletionError(error);
  let failureReason: CompactionFailureReason = 'provider_error';
  if (isAbortErrorDeep(error)) {
    failureReason = 'cancelled';
  } else if (emptyCompletion) {
    failureReason =
      emptyCompletion.reason === 'reasoning_only'
        ? 'reasoning_only'
        : 'empty_summary';
  } else if (
    collectErrorChain(error).some(
      (cause) => cause instanceof CustomProviderAccessError,
    )
  ) {
    failureReason = 'provider_access';
  } else if (hasStructuredMediaTooLargeDetails(error)) {
    failureReason = 'media_too_large';
  } else if (
    inferenceError?.kind === 'prompt_too_long' ||
    isPromptTooLongError(error) ||
    qoderResultCode === RESULT_ERROR_CODES.inputContentTooLong
  ) {
    failureReason = 'prompt_too_long';
  } else if (
    inferenceError?.kind === 'quota_exhausted' ||
    isTerminalQuotaResultErrorCode(qoderResultCode) ||
    transportCode === 'quota_exhausted'
  ) {
    failureReason = 'quota_exhausted';
  } else if (
    inferenceError?.kind === 'auth' ||
    qoderResultCode === RESULT_ERROR_CODES.loginExpired ||
    qoderResultCode === RESULT_ERROR_CODES.customModelAuth ||
    providerStatus === 401 ||
    transportCode === 'auth_error'
  ) {
    failureReason = 'auth_error';
  } else if (
    qoderResultCode === RESULT_ERROR_CODES.modelQueued ||
    qoderResultCode === String(RESULT_ERROR_CODES.modelQueued) ||
    transportCode === 'model_queued'
  ) {
    failureReason = 'model_queued';
  } else if (
    inferenceError?.kind === 'rate_limited' ||
    qoderResultCode === RESULT_ERROR_CODES.usageLimitExceeded ||
    providerStatus === 429 ||
    transportCode === 'rate_limit' ||
    transportCode === 'rate_limited'
  ) {
    failureReason = 'rate_limited';
  } else if (
    inferenceError?.kind === 'server' ||
    qoderResultCode === RESULT_ERROR_CODES.serverInternalError ||
    qoderResultCode === RESULT_ERROR_CODES.customModelService ||
    (providerStatus !== undefined && providerStatus >= 500)
  ) {
    failureReason = 'server_error';
  } else if (
    inferenceError?.kind === 'network' ||
    qoderResultCode === RESULT_ERROR_CODES.requestTimeout ||
    qoderResultCode === RESULT_ERROR_CODES.requestError ||
    providerStatus === 408 ||
    collectErrorCodes(error).some((code) =>
      NETWORK_ERROR_CODES.has(code.toUpperCase()),
    ) ||
    collectErrorMessages(error)
      .join(' ')
      .toLowerCase()
      .includes(FETCH_FAILED_MESSAGE)
  ) {
    failureReason = 'network_error';
  } else if (
    providerStatus === undefined &&
    resultErrorCode === undefined &&
    (error instanceof TypeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error instanceof RangeError)
  ) {
    // Do not hide local programming/configuration defects behind the generic
    // provider-error bucket: retrying the model request cannot repair them.
    failureReason = 'local_error';
  }

  return {
    failureReason,
    ...(providerStatus !== undefined && { providerStatus }),
    ...(errorCode !== undefined && { errorCode }),
    ...(displayErrorCode !== undefined && { displayErrorCode }),
    providerSource,
    ...(errorFallbackMessage && { errorFallbackMessage }),
  };
}

/**
 * 将请求失败包装为流水线结果：无候选历史，Token 数保持原值。
 * 不代表已经消费或保存结果；外层流水线还会合并预算替换、cleanup 和上报。
 */
function createModelRequestFailureResult(
  originalTokenCount: number,
  failure: CompactionRequestFailureInfo,
): CompressionPipelineResult {
  return {
    newHistory: null,
    info: {
      originalTokenCount,
      newTokenCount: originalTokenCount,
      compressionStatus: CompressionStatus.COMPRESSION_FAILED_MODEL_REQUEST,
      ...failure,
    },
  };
}

/** Classify this request's failure without observing unrelated UI notifications. */
async function runCompactionRequest(
  input: CompressionStageContext['input'],
  originalTokenCount: number,
  execute: (signal: AbortSignal) => Promise<string | null>,
  logPrefix: string,
): Promise<
  | { snapshot: string; summaryParseReason: SummaryParseReason }
  | CompressionPipelineResult
> {
  const parentSignal = input.abortSignal;
  const signal = parentSignal ?? new AbortController().signal;
  let rawResult: string | null = null;
  try {
    rawResult = await execute(signal);
  } catch (error) {
    /** 保护步骤 2：保留取消语义；其他最终异常分类后返回 MODEL_REQUEST 失败。 */
    if (isCancellationError(error, parentSignal)) {
      throw error;
    }

    const failure = classifyCompactionRequestError(
      error,
      input.modelResolution.model.source,
    );
    if (failure.failureReason === 'cancelled') {
      runLogger.debug(`[${logPrefix}] fork cancelled`);
    } else {
      runLogger.error(`[${logPrefix}] fork threw:`, error);
    }
    return createModelRequestFailureResult(originalTokenCount, failure);
  }

  /** 保护步骤 4：校验原始文本非空，再格式化摘要；不对清洗后的正文二次判空。 */
  const parsed = extractAndFormatSummary(rawResult);

  if (parsed.summary === null) {
    runLogger.debug(
      `[${logPrefix}] FAILED: no summary text in response, preview:`,
      rawResult?.slice(0, 3000) ?? '(null)',
    );
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
        failureReason: 'empty_summary',
      },
    };
  }

  return {
    snapshot: parsed.summary,
    summaryParseReason: `summary_parse_${parsed.mode}`,
  };
}

/**
 * 构建可取消的摘要执行器；构建时不发送模型请求。
 * 执行器保留父提示词和工具 schema，限制工具执行，调用单轮 Fork 生成摘要。
 * 媒体降级和摘要请求 PTL 重试都在该执行器内，独立于宿主主请求的 reactive 恢复。
 * @param input 模型、提示词、工具、身份及宿主回调等阶段入参。
 * @param originalTokenCount PTL 重试使用的原始 Token 基数。
 * @param messages 本次需要总结的历史；局部压缩仅传入待总结切片。
 * @param forkLabel 摘要 Fork 的用途标签。
 * @returns 接收 AbortSignal、返回模型原始文本的异步函数。
 */
function buildCompactionExecutor(
  input: CompressionStageContext['input'],
  originalTokenCount: number,
  messages: readonly Message[],
  forkLabel: string,
): (signal: AbortSignal) => Promise<string | null> {
  /** 请求步骤 1：准备摘要指令、父工具 schema、原始历史副本并检测内联媒体。 */
  const directive = buildCompactDirective(
    input.config,
    input.customInstructions,
  );
  const parentToolSchemas =
    input.tools ?? input.config.getParentToolSchemas?.();
  const toolRegistry = wrapWithParentToolSchemas(
    parentToolSchemas,
    input.config,
  );
  const originalMessages = [...messages];
  const initialForkContext = buildForkContextMessagesFromPrefix(
    originalMessages,
    input.requestPrefixMessages,
  );
  const initialContextWithoutInlineData =
    stripInlineDataForCompaction(initialForkContext);
  const hasInlineData = initialContextWithoutInlineData.some(
    (message, index) => message !== initialForkContext[index],
  );

  return async (signal) => {
    const ptlOptions: PtlRetryOptions = {
      config: input.config,
      beforeTokenCount: originalTokenCount,
    };
    /**
     * 请求步骤 2：每次尝试复用已解析的模型配置，组装请求前缀并运行单轮 Fork。
     * skipCacheWrite 禁止本次写缓存；保留父前缀仍可尝试读取已有缓存。
     */
    const generateSummary = async (
      messagesToSummarize: Message[],
      stripInlineData: boolean,
    ) => {
      const resolution = await ensureCompactModelSelected(input);
      const { model } = resolution;
      const forkContext = buildForkContextMessagesFromPrefix(
        messagesToSummarize,
        input.requestPrefixMessages,
        buildModelProjectionOptions(input.config, model.key, resolution),
      );
      const forkContextMessages = stripInlineData
        ? stripInlineDataForCompaction(forkContext)
        : forkContext;
      const result = await runForkedAgent({
        config: input.config,
        compactSelection: resolution,
        policyLabels: input.policyLabels,
        prompt: directive,
        model: model.key,
        promptId: input.promptId,
        systemPrompt: input.systemPrompt,
        forkContextMessages,
        forkLabel,
        maxTurns: 1,
        signal,
        skipCacheWrite: true,
        ...(input.customContext !== undefined
          ? { customContext: input.customContext }
          : {}),
        toolRegistry,
        toolExecutor: input.config.getToolExecutor(),
        executionDisabled: true,
        toolChoice: 'none',
        parentRequestSetId: input.parentRequestSetId,
        parentBusinessInfo: input.parentBusinessInfo,
        workdirs: input.config.getWorkspaceContext?.().getDirectories() ?? [],
        sessionId: input.rootSessionId,
        sessionScopeId: input.sessionScopeId,
        onCompleted: (completion) => {
          input.onCompactRequestCompleted?.({
            ...completion,
            model: model.key,
          });
          // Provider-neutral usage omits billing. Read the wire metering by
          // request ID, including failed requests, without session-total deltas.
          const charges = [...new Set(completion.modelRequestIds)]
            .map((id) => getRequestCredits(input.rootSessionId, id))
            .filter((value): value is number => value !== undefined);
          const credits =
            charges.length > 0
              ? charges.reduce((total, value) => total + value, 0)
              : getForkCompletionBilling(completion).credits;
          // Request-level metadata cannot describe a multi-request fork.
          const {
            credits: _credits,
            original_credits: _originalCredits,
            billable: _billable,
            request_id: _requestId,
            ...usage
          } = completion.totalUsage;
          input.onCompactUsage?.({
            sessionId: input.rootSessionId,
            ...(input.agentId ? { agentId: input.agentId } : {}),
            modelRequestIds: completion.modelRequestIds,
            usage: { ...usage, ...(credits !== undefined ? { credits } : {}) },
          });
        },
      });
      return result.textContent || '';
    };

    /**
     * 请求步骤 3：有内联媒体时先原样请求，以保留父前缀。
     * 只有媒体过大或超窗才进入去媒体路径，其他异常直接交给外层分类。
     */
    if (hasInlineData) {
      try {
        // Preserve the unmodified prefix on the first attempt so the compact
        // fork can still share the parent prompt cache.
        return await generateSummary(originalMessages, false);
      } catch (error) {
        const failure = classifyCompactionRequestError(
          error,
          input.modelResolution.model.source,
        );
        const failureReason = failure.failureReason;
        if (
          failureReason !== 'media_too_large' &&
          failureReason !== 'prompt_too_long'
        ) {
          throw error;
        }
        runLogger.debug(
          `[CompressionV2] Compact request failed with ${failureReason}; retrying without inline media`,
        );
      }
    }

    /**
     * 请求步骤 4：进入摘要请求的 PTL 包装；有媒体时使用去媒体后的请求。
     * PTL 可裁旧轮次后最多重试 3 次；不可再裁或次数耗尽时抛给额度保护层。
     */
    return withPtlRetry(
      (messagesToSummarize) =>
        generateSummary(messagesToSummarize, hasInlineData),
      originalMessages,
      ptlOptions,
    );
  };
}

/**
 * 对工作历史执行完整 Fork 摘要压缩，底层复用主 Agent 的 query 执行机制。
 * @param context 当前可压缩历史、阶段入参和流水线状态。
 * @returns 成功时返回 newHistory、前后 Token 数和 compactSummary；失败时返回状态。
 * 候选历史由宿主消费；本函数不持久化历史，也不调用 PostCompact / SessionStart。
 */
export async function runForkCompact(
  context: CompressionStageContext,
): Promise<CompressionPipelineResult> {
  const { input } = context;

  /** 完整压缩步骤 1：取得压缩前 Token 数，发送 summarizing 进度事件。 */
  const originalTokenCount = getOriginalTokenCount(context);

  coreEvents.emitCompressionProgress({
    stage: 'summarizing',
    trigger: input.trigger,
    sessionId: input.rootSessionId,
    sessionScopeId: input.sessionScopeId,
    target: input.target,
    agentId: input.agentId,
    tokensBeforeCompact: originalTokenCount,
  });

  /** 完整压缩步骤 2：在额度保护下执行摘要请求；请求或空摘要失败直接返回。 */
  const split = splitForCompaction(context.workingHistory);
  // With no older response to summarize, retain the existing full-summary
  // recovery path rather than making a long opening turn impossible to compact.
  const segmented =
    split.summaryHistory.length > 0 &&
    canPreserveResponseGroup(
      split.preservedMessages,
      new Set(context.state.seenFunctionResponseIds),
    );
  const summaryHistory = segmented
    ? split.summaryHistory
    : context.workingHistory;
  const callResult = await runCompactionRequest(
    input,
    originalTokenCount,
    buildCompactionExecutor(
      input,
      originalTokenCount,
      summaryHistory,
      'compact',
    ),
    'fork-compact',
  );
  if (!('snapshot' in callResult)) return callResult;
  const { snapshot, summaryParseReason } = callResult;

  /** 完整压缩步骤 3：摘要有效后发送 post_processing，组装边界、摘要和必要尾部。 */
  // Emit 'post_processing' — LLM returned a valid summary; now assembling
  // the new compressed history.
  coreEvents.emitCompressionProgress({
    stage: 'post_processing',
    trigger: input.trigger,
    sessionId: input.rootSessionId,
    sessionScopeId: input.sessionScopeId,
    target: input.target,
    agentId: input.agentId,
    tokensBeforeCompact: originalTokenCount,
  });

  const newHistory = buildPostCompactHistory(
    snapshot,
    segmented ? [] : context.workingHistory,
    new Set(context.state.seenFunctionResponseIds),
    {
      trigger: toCompactMetadataTrigger(input.trigger),
      preTokens: originalTokenCount,
      messagesSummarized: summaryHistory.length,
    },
    {
      transcriptPath: input.transcriptPath,
      isAutoCompact: input.trigger === 'auto',
      hasPreservedMessages: segmented && split.preservedMessages.length > 0,
    },
  );

  if (segmented) {
    retainCompactionPrefix(
      context.fullHistory,
      newHistory,
      split.preservedMessages,
    );
    newHistory.push(...split.preservedMessages);
  }

  /** 完整压缩步骤 4：估算新历史；未减少 Token 就返回膨胀失败，不在此重生成摘要。 */
  try {
    const newTokenCount = estimateBlocksTokenCount(
      newHistory.flatMap((msg) => getContentBlocks(msg)),
    );

    if (newTokenCount >= originalTokenCount) {
      return {
        newHistory: null,
        info: {
          originalTokenCount,
          newTokenCount,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        },
      };
    }

    /** 完整压缩步骤 5：补齐边界 Token 元数据，返回 COMPRESSED 候选结果。 */
    setBoundaryPostTokens(newHistory, newTokenCount);

    return {
      newHistory,
      info: {
        originalTokenCount,
        newTokenCount,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
      compactSummary: snapshot,
      summaryParseReason,
    };
  } catch {
    /** 完整压缩步骤 6：上述后处理抛错时返回 TOKEN_COUNT_ERROR，交给外层收尾。 */
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus:
          CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Partial compact — summarize only a slice of the working history
// ---------------------------------------------------------------------------

/**
 * 局部压缩实现：只总结 toSummarize 切片，再与原样保留的 toKeep 拼接。
 * 由 pipeline 的 partialOptions 分支调用；当前未发现标准生产入口传入该选项，
 * 不能据此认定 CLI 已支持带方向和锚点参数的 /compact 命令。
 * @param context 标准阶段上下文。
 * @param partialOptions 控制切片方向和分界位置。
 * @returns 空切片返回 NOOP；否则返回候选历史或失败状态。
 */
export async function runPartialForkCompact(
  context: CompressionStageContext,
  partialOptions: PartialCompactOptions,
): Promise<CompressionPipelineResult> {
  const { input } = context;

  const originalTokenCount = getOriginalTokenCount(context);

  /** 局部步骤 1：按方向和锚点切分历史；待总结部分为空时直接 NOOP。 */
  const { toSummarize, toKeep } = sliceHistoryForPartialCompact(
    context.workingHistory,
    partialOptions,
  );

  if (toSummarize.length === 0) {
    runLogger.debug(
      '[partial-fork-compact] nothing to summarize at the given pivot — NOOP',
    );
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus: CompressionStatus.NOOP,
      },
    };
  }

  /** 局部步骤 2：复用同一请求执行器与额度保护，仅向模型提供待总结切片。 */
  coreEvents.emitCompressionProgress({
    stage: 'summarizing',
    trigger: 'manual',
    sessionId: input.rootSessionId,
    sessionScopeId: input.sessionScopeId,
    target: input.target,
    agentId: input.agentId,
    tokensBeforeCompact: originalTokenCount,
  });

  const callResult = await runCompactionRequest(
    input,
    originalTokenCount,
    buildCompactionExecutor(
      input,
      originalTokenCount,
      toSummarize,
      'partial-compact',
    ),
    'partial-fork-compact',
  );
  if (!('snapshot' in callResult)) return callResult;
  const { snapshot, summaryParseReason } = callResult;

  coreEvents.emitCompressionProgress({
    stage: 'post_processing',
    trigger: 'manual',
    sessionId: input.rootSessionId,
    sessionScopeId: input.sessionScopeId,
    target: input.target,
    agentId: input.agentId,
    tokensBeforeCompact: originalTokenCount,
  });

  /** 局部步骤 3：根据方向把摘要与保留原文拼接，生成带压缩边界的新历史。 */
  const newHistory = buildPartialCompactHistory(
    snapshot,
    partialOptions.direction,
    toKeep,
    {
      trigger: 'manual',
      preTokens: originalTokenCount,
      messagesSummarized: toSummarize.length,
    },
    { transcriptPath: input.transcriptPath },
  );

  try {
    const newTokenCount = estimateBlocksTokenCount(
      newHistory.flatMap((msg) => getContentBlocks(msg)),
    );

    setBoundaryPostTokens(newHistory, newTokenCount);

    /**
     * 局部步骤 4：返回新 Token 数和压缩后的候选历史。
     * 与完整压缩不同，此分支没有 newTokenCount >= originalTokenCount 的拒绝判断。
     */
    return {
      newHistory,
      info: {
        originalTokenCount,
        newTokenCount,
        compressionStatus: CompressionStatus.COMPRESSED,
      },
      compactSummary: snapshot,
      summaryParseReason,
    };
  } catch {
    /** 局部步骤 5：该 try 块后处理异常返回 TOKEN_COUNT_ERROR，交给外层收尾。 */
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus:
          CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
      },
    };
  }
}
