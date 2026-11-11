/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompressionStatus,
  type ChatCompressionInfo,
} from '../core/turn-events.js';
import { getCompressionConfig } from './config.js';
import { runForkCompact } from './fork-compact.js';
import { getAutoCompactModelThresholdCap } from './config/autoCompactModelThresholdCaps.js';
import { getAutoCompactThreshold } from './thresholds.js';
import { runLogger } from '../utils/runLogger.js';
import { shouldExposeTokenUsage } from '../protocol/token-usage-visibility.js';
import { coreEvents } from '../utils/events.js';
import {
  toPreCompactTrigger,
  type CompressionPipelineResult,
  type CompressionStageContext,
} from './types.js';
import { ensureCompactModelSelected } from './compact-model.js';

function formatUsageBucket(tokenCount: number, threshold: number): string {
  if (threshold <= 0) {
    return 'threshold-floor';
  }

  const percent = (tokenCount / threshold) * 100;
  if (percent < 50) return 'lt_50%';
  if (percent < 75) return '50_75%';
  if (percent < 90) return '75_90%';
  if (percent < 100) return '90_100%';
  if (percent < 110) return '100_110%';
  return 'gte_110%';
}

function formatReductionBucket(
  originalTokenCount: number,
  newTokenCount: number,
): string {
  if (originalTokenCount <= 0) {
    return 'unknown';
  }

  const reductionRatio =
    (originalTokenCount - newTokenCount) / originalTokenCount;
  if (reductionRatio <= 0) return 'none';
  if (reductionRatio < 0.25) return 'lt_25%';
  if (reductionRatio < 0.5) return '25_50%';
  if (reductionRatio < 0.75) return '50_75%';
  return 'gte_75%';
}

function formatCompressionStatus(status: CompressionStatus): string {
  return CompressionStatus[status].toLowerCase();
}

function logCompactionResult(
  tag: string,
  label: string,
  result: CompressionPipelineResult,
): void {
  const status = formatCompressionStatus(result.info.compressionStatus);
  const reduction = formatReductionBucket(
    result.info.originalTokenCount,
    result.info.newTokenCount,
  );
  const msg = `${tag} ${label}: status=${status}, reduction=${reduction}`;
  if (result.info.compressionStatus === CompressionStatus.COMPRESSED) {
    runLogger.log(msg);
  } else if (result.info.compressionStatus === CompressionStatus.NOOP) {
    runLogger.debug(msg);
  } else {
    runLogger.warn(msg);
  }
}

export function createNoopResult(
  compressionStatus: ChatCompressionInfo['compressionStatus'],
  tokenCount: number,
  blockReason?: string,
): CompressionPipelineResult {
  return {
    newHistory: null,
    info: {
      originalTokenCount: tokenCount,
      newTokenCount: tokenCount,
      compressionStatus,
      ...(blockReason !== undefined && { blockReason }),
    },
  };
}

/**
 * 执行摘要压缩阶段，供自动、手动和 reactive 触发路径共用。
 * 按下方 1–9 步检查条件、选择摘要策略、执行 Hook 并返回阶段结果。
 */
export async function runAutoCompactStage(
  context: CompressionStageContext,
): Promise<CompressionPipelineResult> {
  const { input } = context;
  const config = getCompressionConfig(input.config);
  /**
   * 步骤 1：取得本次 Token 数并计算阈值。
   * 使用流水线统一计算的 promptTokenCount；
   * 通知阈值观察回调，回调异常不影响压缩决策。
   */
  const tokenCount = input.promptTokenCount;
  const modelEntry = input.modelResolution.model;
  const baseThreshold = getAutoCompactThreshold(
    modelEntry,
    input.modelResolution.config.context?.contextWindow,
  );
  // Only non-forced auto compaction is driven by this threshold. Manual and
  // reactive callers force compaction; forced auto calls also bypass the check.
  const isAutomaticCheck = input.trigger === 'auto' && !input.force;
  // Reuse the model already supplied to this threshold check. Do not resolve
  // another model, alter the compact router, or lower the real context window.
  const qcsCap = isAutomaticCheck
    ? getAutoCompactModelThresholdCap(input.modelResolution.model.key)
    : undefined;
  const threshold = Math.min(baseThreshold, qcsCap ?? baseThreshold);
  try {
    input.onAutoCompactThresholdResolved?.(threshold);
    if (isAutomaticCheck) {
      input.onAutoCompactPolicyResolved?.(
        {
          model: input.modelResolution.model.key,
          base_threshold_tokens: baseThreshold,
          qcs_cap_tokens: qcsCap ?? null,
          evaluated_tokens: tokenCount,
        },
        threshold,
      );
    }
  } catch {
    // Observers must never affect the compression decision.
  }
  const sessionTag = `[auto-compact][session:${input.sessionScopeId}]`;
  const tag = input.agentId
    ? `${sessionTag}[subagent:${input.agentId}]`
    : `${sessionTag}[${input.target}]`;
  const usageBucket = formatUsageBucket(tokenCount, threshold);
  const thresholdState = tokenCount >= threshold ? 'at_or_above' : 'below';

  // A >2x-low threshold count once went unnoticed for four days because this
  // line printed only `usage=lt_50%`. `anchor` and `window_source` say WHICH
  // side is wrong without needing a repro, and neither is user token usage:
  //   anchor=staged-estimate  -> the count came from local estimation, not usage
  //   window_source=global-fallback -> the gate resolved its own window and may
  //                                    disagree with the status line / wall
  // Concrete counts stay behind ENV_EXPOSE_TOKEN_USAGE: these logs ship in
  // /feedback bundles, and the no-raw-counts contract is asserted by
  // auto-compact-observability.test.ts.
  const countDetail = shouldExposeTokenUsage()
    ? `, tokens=${tokenCount}, threshold=${threshold}`
    : '';
  runLogger.log(
    `${tag} threshold check: state=${thresholdState}, usage=${usageBucket}${countDetail}, ` +
      `window=${input.modelResolution.config.context?.contextWindow ?? 'unset'}, ` +
      `window_source=${input.modelResolution.config.context?.contextWindow !== undefined ? 'caller' : 'global-fallback'}, ` +
      `anchor=${input.promptTokenSource ?? 'unknown'}, ` +
      `model=${input.modelResolution.model.key}, force=${input.force ?? false}, cap_source=${qcsCap === undefined ? 'default' : 'qcs'}`,
  );

  /** 步骤 2：未强制压缩时检查阈值；低于阈值直接返回 NOOP。 */
  if (!input.force) {
    if (tokenCount < threshold) {
      if (runLogger.isDebugEnabled) {
        runLogger.debug(
          `${tag} skipped: below auto-compact threshold, usage=${usageBucket}`,
        );
      }
      return createNoopResult(CompressionStatus.NOOP, tokenCount);
    }
  }

  /**
   * 步骤 3：设置自动压缩的阻断状态，两种情况都会阻断继续自动压缩
   * 1. blockedReason !== undefined。只有自动压缩遇到额度耗尽、认证错误、本地错误或 Token 计数错误，才会设置它。普通网络失败不会立即阻断。
   * 2. 当前用户请求内，自动压缩累计连续失败达到最大值，settigns.json 可以设置，默认 3 次。成功会清零；新用户请求会重新计数。
   */
  const isConditionBlocked =
    input.autoCompactTracking.blockedReason !== undefined;
  const isAutoCircuitOpen =
    input.trigger === 'auto' &&
    input.autoCompactTracking.consecutiveFailures >=
      config.autoCompact.maxConsecutiveFailures;
  if (isConditionBlocked || isAutoCircuitOpen) {
    const breakerReason = input.autoCompactTracking.blockedReason
      ? `blocked_reason=${input.autoCompactTracking.blockedReason}`
      : `consecutive_failures=${input.autoCompactTracking.consecutiveFailures}, max_failures=${config.autoCompact.maxConsecutiveFailures}`;
    const lastFailure = input.autoCompactTracking.lastFailureReason
      ? `, last_failure=${input.autoCompactTracking.lastFailureReason}`
      : '';
    runLogger.warn(
      `${tag} skipped: circuit breaker open, scope=current_query, ${breakerReason}${lastFailure}`,
    );
    return createNoopResult(CompressionStatus.NOOP, tokenCount);
  }

  /** 步骤 4：条件通过后发送 starting 进度事件，表示准备执行实际压缩。 */
  // Emit only after all threshold and breaker checks have passed. Emitting
  // earlier makes every non-empty request look like an active compaction.
  coreEvents.emitCompressionProgress({
    stage: 'starting',
    trigger: input.trigger,
    sessionId: input.rootSessionId,
    sessionScopeId: input.sessionScopeId,
    target: input.target,
    agentId: input.agentId,
    tokensBeforeCompact: tokenCount,
  });

  runLogger.log(
    `${tag} triggering compaction: reason=${input.force ? 'forced' : 'threshold_exceeded'}, usage=${usageBucket}`,
  );

  /** 步骤 5：解析压缩模型，后续 Hook 和摘要请求复用同一配置。 */
  await ensureCompactModelSelected(input);
  const hookModel = input.modelResolution.model.key;

  /**
   * 步骤 6：执行 PreCompact Hook。
   * Hook 返回 stop 或 block 时，以 PRECOMPACT_BLOCKED 状态结束本阶段。
   */
  // Fire PreCompact only when compression is actually about to happen.
  const trigger = toPreCompactTrigger(input.trigger);
  const preCompactResult = await input.config
    .getHookSystem?.()
    ?.firePreCompactEvent(
      trigger,
      input.customInstructions ?? '',
      undefined,
      hookModel,
    );

  if (preCompactResult?.finalOutput?.shouldStopExecution?.()) {
    runLogger.warn(`${tag} blocked by PreCompact hook: decision=stop`);
    return createNoopResult(
      CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
      tokenCount,
      preCompactResult.finalOutput.getEffectiveReason(),
    );
  }

  if (preCompactResult?.finalOutput?.isBlockingDecision?.()) {
    runLogger.warn(`${tag} blocked by PreCompact hook: decision=block`);
    return createNoopResult(
      CompressionStatus.COMPRESSION_FAILED_PRECOMPACT_BLOCKED,
      tokenCount,
      preCompactResult.finalOutput.getEffectiveReason(),
    );
  }

  /**
   * 步骤 7：提取 Hook 的 additionalContext（缺省时取 stdout），
   * 追加到或设置为 customInstructions，供后续 Fork 摘要请求使用。
   */
  // Consume additionalContext from PreCompact hook — append to custom instructions
  const preCompactAdditionalContext =
    preCompactResult?.finalOutput?.getAdditionalContext?.() ??
    preCompactResult?.finalOutput?.getStdoutContent?.();
  if (preCompactAdditionalContext && input.customInstructions !== undefined) {
    input.customInstructions = `${input.customInstructions}\n${preCompactAdditionalContext}`;
  } else if (preCompactAdditionalContext) {
    input.customInstructions = preCompactAdditionalContext;
  }
  if (preCompactAdditionalContext && runLogger.isDebugEnabled) {
    runLogger.debug(`${tag} PreCompact hook supplied additional context`);
  }

  /** 步骤 8：执行 Fork 摘要，内部负责请求恢复和摘要校验。 */
  const forkResult = await runForkCompact(context);
  /**
   * 步骤 9：为 Fork 结果补充 Hook 使用的模型，记录结果日志并返回。
   * 流水线外层继续处理状态清理、结果上报和压缩后的 Hook。
   */
  forkResult.hookModel = input.modelResolution.model.key;
  logCompactionResult(tag, 'snapshot compactor finished', forkResult);
  return forkResult;
}
