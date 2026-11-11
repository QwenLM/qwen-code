/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `get_model_policy`：每次模型调用前向宿主拉取本轮的模型、参数与直连决定。
 *
 * 本模块只产产品级 payload 并做响应归一化；control_request 信封、request_id 与
 * wire 字段映射归宿主。宿主声明了 `modelPolicyProvider` 才启用；策略拿不到时
 * 原样抛出，不能静默回落到平台模型。
 */

import {
  FatalCancellationError,
  isCancellationError,
  isRecord,
  parseReasoningEffortLevel,
  runLogger,
  type GetModelPolicyCallback,
  type GetModelPolicyResult,
  type ModelPolicyLabels,
  type ModelPolicyParameters,
} from '@qwen-code/core';
import type { ThreadHostRequests } from '../contract/hostContext.js';

/** catalog-ready 声明的最短超时。 */
const MODEL_POLICY_TIMEOUT_MS = 10_000;

function stringifyModelPolicyModel(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const jsonValue = JSON.stringify(value);
  return jsonValue ?? String(value);
}

// 策略参数在 wire 上是 camelCase（contextWindow / reasoningEffort / outerProvider），
// 而 `custom_model` / `api_key` 以及 CLI→后端的 `parameters` 载荷是 snake_case；
function normalizeModelPolicyParameters(
  value: Record<string, unknown> | undefined,
): ModelPolicyParameters | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parameters: ModelPolicyParameters = {};
  const contextWindow = value['contextWindow'];
  if (
    typeof contextWindow === 'number' &&
    Number.isInteger(contextWindow) &&
    contextWindow > 0
  ) {
    parameters.contextWindow = contextWindow;
  }

  const reasoningEffort = parseReasoningEffortLevel(value['reasoningEffort']);
  if (reasoningEffort !== undefined) {
    parameters.reasoningEffort = reasoningEffort;
  }

  const outerProvider = value['outerProvider'];
  if (typeof outerProvider === 'string') {
    parameters.outerProvider = outerProvider;
  }

  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

/** 仅接受 trim 后非空的字符串标签（task_id / sub_task），其余一律忽略。 */
function normalizePolicyLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 收拢 wire 上的请求级标签；全部缺失时返回 undefined。 */
function normalizePolicyLabels(
  value: Record<string, unknown>,
): ModelPolicyLabels | undefined {
  const taskId = normalizePolicyLabel(value['task_id']);
  const subTask = normalizePolicyLabel(value['sub_task']);
  if (taskId === undefined && subTask === undefined) {
    return undefined;
  }
  return {
    ...(taskId !== undefined ? { taskId } : {}),
    ...(subTask !== undefined ? { subTask } : {}),
  };
}

/**
 * 三态返回：`undefined` = Host 明确不覆盖，`null` = 响应非法，其余 = 归一化后的策略。
 * 非法与不覆盖必须分开——前者要抛错（见文件头「策略失败为什么必须抛」），后者正常回落。
 */
function normalizeGetModelPolicyResponse(
  value: unknown,
): GetModelPolicyResult | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const model = value['model'];
  const hasModel = model !== undefined && model !== null && model !== '';
  const parameters = value['parameters'];
  if (parameters !== undefined && !isRecord(parameters)) {
    return null;
  }
  const outerProvider = parameters?.['outerProvider'];
  if (
    outerProvider !== undefined &&
    (typeof outerProvider !== 'string' || outerProvider.length === 0)
  ) {
    return null;
  }
  const modelPolicyParameters = normalizeModelPolicyParameters(parameters);
  const customModelValue = value['custom_model'];
  if (customModelValue !== undefined && customModelValue !== null) {
    // 内联直连凭据没有对应的 Provider 模型；拒绝，避免回落到平台模型消耗平台积分。
    throw new Error('get_model_policy custom_model is not supported');
  }
  const labels = normalizePolicyLabels(value);
  if (
    !hasModel &&
    modelPolicyParameters === undefined &&
    labels === undefined
  ) {
    return undefined;
  }
  return {
    ...(hasModel ? { model: stringifyModelPolicyModel(model) } : {}),
    ...(modelPolicyParameters !== undefined
      ? { parameters: modelPolicyParameters }
      : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}

function isModelPolicyCancellationError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  return (
    error instanceof FatalCancellationError ||
    isCancellationError(error, signal)
  );
}

export interface ModelPolicyProviderParams {
  readonly sessionId: string;
  /** 宿主的拉取式策略反向请求；信封与 request_id 关联归宿主。 */
  readonly getModelPolicy: ThreadHostRequests['getModelPolicy'];
  /** `initialize` 声明的 `modelPolicyProvider`；装配时还没定，必须用 getter 读。 */
  readonly isEnabled: () => boolean;
}

export function createModelPolicyCallback(
  params: ModelPolicyProviderParams,
): GetModelPolicyCallback {
  const { sessionId, getModelPolicy, isEnabled } = params;

  // 回调形状绑在 core 的 GetModelPolicyCallback 上，参数类型由它上下文推出
  // （purpose 的 QoderModelPurpose 来自 core 的 model-policy，不在这里
  // 显式 import SDK 协议包）。
  return async (
    purpose,
    policySessionId,
    turnIndex,
    agentId,
    signal,
    extras,
  ) => {
    if (!isEnabled()) {
      return undefined;
    }
    try {
      let timer: ReturnType<typeof setTimeout>;
      const rawResponse = await Promise.race([
        getModelPolicy(
          {
            purpose,
            sessionId: policySessionId,
            turnIndex,
            agentId,
            agentType: extras?.agentType,
            resolvedModel: extras?.resolvedModel,
            contextUsage: extras?.contextUsage,
            estimatedInputTokens: extras?.estimatedInputTokens,
            estimatedOutputTokens: extras?.estimatedOutputTokens,
            retry: extras?.retry,
          },
          { signal },
        ).finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('get_model_policy timeout')),
            MODEL_POLICY_TIMEOUT_MS,
          );
        }),
      ]);
      const policyResult = normalizeGetModelPolicyResponse(rawResponse);
      if (policyResult !== null) {
        // resolveModel 的原始回包标签，默认级别。与 [business-info] 那条配对读：
        // 本条记宿主**回了什么**，那条记请求**最终带了什么**；两者不一致即说明
        // 中间某一环（querySource 常量覆盖、子代理默认合并）改写了标签。
        // sub_task 只存在于 resolveModel 回包与请求体里；
        // 值截断 64 字符：标签是宿主可控字符串。
        runLogger.log('[model-policy] resolveModel 回包标签', {
          sessionId,
          purpose,
          // 三态里 undefined＝宿主明确不覆盖：标签按未设置记，不能解引用崩掉。
          sub_task: policyResult?.labels?.subTask?.slice(0, 64) ?? '(未设置)',
          task_id: policyResult?.labels?.taskId?.slice(0, 64) ?? '(未设置)',
        });
        return policyResult;
      }
      throw new Error(
        `get_model_policy returned invalid response for ${purpose}`,
      );
    } catch (error) {
      if (isModelPolicyCancellationError(error, signal)) {
        throw error;
      }
      runLogger.error(
        `[thread-session] get_model_policy failed for ${purpose}`,
        {
          sessionId,
          error,
        },
      );
      // 策略失败不能视作无覆盖，否则宿主直连请求会沿启动模型进入平台计费路径。
      throw error;
    }
  };
}
