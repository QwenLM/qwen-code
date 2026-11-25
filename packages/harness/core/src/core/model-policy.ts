/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { QoderModelPurpose } from '../protocol/wire/index.js';
import type { ReasoningEffortLevel } from '../provider/model/model.js';
import type {
  ModelPurpose,
  ModelPolicyInput,
  ModelSelectContext,
} from '../provider/model/modelSelectContext.js';

import type { ModelPolicyLabels } from '../provider/model/modelSelection.js';
import type { ModelSelectionPolicy } from '../provider/model/modelSelector.js';
export type {
  ModelPolicyInput,
  RequestModelOverride,
} from '../provider/model/modelSelectContext.js';
export type { ModelPolicyLabels } from '../provider/model/modelSelection.js';

/** SDK 用途保持产品原有分类，不扩散到通用 Provider 契约。 */
export interface ModelPolicySelectContext extends ModelSelectContext {
  readonly policyPurpose?: QoderModelPurpose;
  readonly querySource?: 'side_question';
  readonly workdirs?: readonly string[];
}

export interface ModelPolicyParameters {
  contextWindow?: number;
  reasoningEffort?: ReasoningEffortLevel;
  /** 外部模型渠道，用于加载对应渠道的模型能力元数据。 */
  outerProvider?: string;
}

/**
 * Result returned by the `getModelPolicy` callback.
 */
export interface GetModelPolicyResult {
  /** Optional model override for this request. Omitted means keep the base resolution. */
  model?: string;
  /** Optional model policy parameters. */
  parameters?: ModelPolicyParameters;
  /** Optional request-scoped routing/billing labels. */
  labels?: ModelPolicyLabels;
}

/**
 * Additional context passed to the getModelPolicy callback beyond the
 * positional parameters.
 */
export interface GetModelPolicyExtras {
  /** Stable subagent type, if this request belongs to a subagent. */
  agentType?: string;
  /** Model already selected by the CLI before consulting the SDK host. */
  resolvedModel?: string;
  /** Context window usage ratio (0~1). */
  contextUsage?: number;
  /** Estimated input token count for this request. */
  estimatedInputTokens?: number;
  /** Estimated output token count for this request. */
  estimatedOutputTokens?: number;
  /** Retry information when retrying after a failure. */
  retry?: {
    attempt: number;
    lastError: string;
    lastModelId: string;
  };
}

/**
 * Callback that queries the SDK host for the model to use before each LLM
 * request. The CLI sends a `get_model_policy` control_request to the SDK,
 * which invokes the host's `modelPolicyProvider` callback and returns the
 * chosen model.
 *
 * 成功返回 undefined 表示宿主明确不覆盖；拒绝、超时或非法响应表示解析失败，
 * 调用方必须停止该次模型请求，不能改用默认模型，以免直连请求意外消耗平台积分。
 */
export type GetModelPolicyCallback = (
  purpose: QoderModelPurpose,
  sessionId: string,
  turnIndex: number,
  agentId?: string,
  signal?: AbortSignal,
  extras?: GetModelPolicyExtras,
) => Promise<GetModelPolicyResult | undefined>;

/** query 业务场景到旧 SDK 用途的边界映射，不把协议分类交给 query。 */
export function queryModelSelectContext(input: {
  purpose?: ModelPurpose;
  isSubagent?: boolean;
}): Pick<ModelPolicySelectContext, 'purpose' | 'policyPurpose'> {
  const purpose = input.purpose ?? (input.isSubagent ? 'task' : 'main');
  const policyPurpose =
    purpose === 'fork' ? (input.isSubagent ? 'task' : 'main') : purpose;
  return {
    purpose,
    policyPurpose:
      policyPurpose === 'side_question' ||
      policyPurpose === 'auto_permission' ||
      policyPurpose === 'insights' ||
      policyPurpose === 'summary'
        ? 'utility'
        : policyPurpose,
  };
}

/** 只转换已有宿主协议；选模顺序和恢复由 selector 决定。 */
export function createModelSelectionPolicy(
  getModelPolicy: GetModelPolicyCallback,
): ModelSelectionPolicy {
  return (context: ModelPolicySelectContext, baseSelection) =>
    readModelPolicy(
      {
        policyPurpose:
          context.policyPurpose ??
          (context.purpose === 'side_question'
            ? 'utility'
            : context.purpose === 'fork'
              ? context.request?.agentId
                ? 'task'
                : 'main'
              : context.purpose === 'task'
                ? 'subagent'
                : context.purpose === 'compact'
                  ? 'compression'
                  : context.purpose === 'plan'
                    ? 'main'
                    : context.purpose === 'auto_permission' ||
                        context.purpose === 'insights' ||
                        context.purpose === 'summary'
                      ? 'utility'
                      : context.purpose),
        policy: context.request!,
        signal: context.signal,
      },
      getModelPolicy,
      baseSelection?.model.key,
    );
}

async function readModelPolicy(
  options: {
    policyPurpose: QoderModelPurpose;
    policy: ModelPolicyInput;
    signal?: AbortSignal;
  },
  getModelPolicy: GetModelPolicyCallback,
  resolvedModel?: string,
): Promise<Awaited<ReturnType<ModelSelectionPolicy>>> {
  const input = options.policy;
  const extras: GetModelPolicyExtras = {};
  if (resolvedModel !== undefined) extras.resolvedModel = resolvedModel;
  if (input.agentType) extras.agentType = input.agentType;
  if (input.cumulativeUsage?.input_tokens)
    extras.estimatedInputTokens = input.cumulativeUsage.input_tokens;
  if (input.retry) extras.retry = input.retry;
  const policy = await getModelPolicy(
    options.policyPurpose,
    input.sessionId,
    input.turnIndex,
    input.agentId,
    options.signal,
    extras,
  );
  if (!policy) return undefined;
  const effort = policy.parameters?.reasoningEffort;
  const contextWindow = policy.parameters?.contextWindow;
  return {
    key: policy.model || undefined,
    config:
      effort !== undefined || contextWindow !== undefined
        ? {
            ...(effort !== undefined ? { reasoning: { effort } } : {}),
            ...(contextWindow !== undefined
              ? { context: { contextWindow } }
              : {}),
          }
        : undefined,
    labels: policy.labels,
  };
}
