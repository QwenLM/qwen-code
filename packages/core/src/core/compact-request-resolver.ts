/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompactModelSource } from '../compression-v2/types.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { ModelPolicyLabels } from './model-policy.js';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import type { LlmGenerationConfig } from '../config/generation-config.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { Config } from '../config/config.js';
import type { CompactModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelPolicySelectContext } from './model-policy.js';
import type { ModelConfig } from '../provider/model/model.js';
import { createModelRequestGuard } from '../provider/session-model.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import { generationFromModelConfig } from '../config/generation-config.js';
import { runLogger } from '../utils/runLogger.js';

/** Session-policy result adapted to the Provider-only compression pipeline. */
export interface CompressionRequestModel {
  modelResolution: ModelSelection;
  policyLabels?: ModelPolicyLabels;
  model: string;
  /** Selection source, when resolution supplied one. */
  source?: CompactModelSource;
  reasoningEffort?: ReasoningEffortLevel;
  generation?: LlmGenerationConfig;
  contextWindow?: number;
}

/**
 * 缓存压缩父准备与最终选模的 Promise，将 Provider 结果适配给压缩管线。
 * 选模顺序、SDK 恢复与本地降级均由会话 selector 处理。
 */
export function createCompactRequestResolver(options: {
  config?: Config;
  parent?:
    | CompressionRequestModel
    | {
        model: string;
        config: ModelConfig;
        source?: CompressionRequestModel['source'];
      };
  signal: AbortSignal;
  sessionId: string;
  turnIndex: number;
  logLabel: string;
  isSubagent?: boolean;
  agentId?: string;
  agentType?: string;
  cumulativeUsage?: NonNullableUsage;
}): (() => Promise<CompressionRequestModel>) & {
  /** 先准备合法父模型；仅前置 404 才提前恢复，正常 compact 策略仍由管线延后调用。 */
  prepareParent: () => Promise<CompressionRequestModel>;
} {
  const rawParent =
    options.parent && !('modelResolution' in options.parent)
      ? options.parent
      : undefined;
  let parent =
    options.parent && 'modelResolution' in options.parent
      ? options.parent
      : undefined;
  const parentSource = options.parent ? options.parent.source : 'current';
  let guard: (() => void) | undefined;
  let requestWorkdirs: readonly string[] | undefined;
  const getWorkdirs = () =>
    (requestWorkdirs ??= options
      .config!.getWorkspaceContext()
      .getDirectories());
  const assertCurrent = () => {
    if (!options.config?.hasModelProviderManager()) {
      throw new Error('A session ModelProvider is required for compaction.');
    }
    guard ??= createModelRequestGuard(options.config, options.signal);
    guard();
  };
  const wait = async <T>(promise: Promise<T>): Promise<T> => {
    const result = await raceWithAbortSignal(promise, options.signal);
    assertCurrent();
    return result;
  };
  const select = async (
    prepareParent?: true,
  ): Promise<CompressionRequestModel> => {
    assertCurrent();
    const workdirs = getWorkdirs();
    const input: CompactModelSelectContext & ModelPolicySelectContext = {
      purpose: 'compact',
      policyPurpose: 'compact',
      parentSelection: parent?.modelResolution,
      ...(rawParent
        ? { parentOverride: { key: rawParent.model, config: rawParent.config } }
        : {}),
      ...(prepareParent ? { prepareParent } : {}),
      overrideSelection:
        parentSource === 'explicit'
          ? parent
            ? { model: parent.modelResolution.model, config: {} }
            : { key: rawParent!.model, config: {} }
          : undefined,
      ...(workdirs.length > 0 ? { workdirs } : {}),
      signal: options.signal,
      request: {
        sessionId: options.sessionId,
        turnIndex: options.turnIndex,
        agentId: options.agentId,
        agentType: options.agentType,
        cumulativeUsage: options.cumulativeUsage,
      },
    };
    const selected = await wait(
      options.config!.getModelProviderManager().select(input),
    );
    if (selected.fallbackToParent && parent) return parent;
    const resolution: ModelSelection = {
      model: selected.model,
      config: selected.config,
    };
    const request: CompressionRequestModel = {
      modelResolution: resolution,
      model: resolution.model.key,
      source: selected.policy?.overridden
        ? 'sdk-policy'
        : selected.preparedParentOnly || selected.fallbackToParent
          ? parentSource
          : (parentSource ?? 'fixed'),
      reasoningEffort: resolution.config.reasoning?.effort,
      generation: generationFromModelConfig(resolution.config),
      contextWindow: resolution.config.context?.contextWindow,
      policyLabels: selected.policy?.labels ?? parent?.policyLabels,
    };
    if (selected.preparedParentOnly) {
      parent = request;
    } else {
      // 父准备的 404 恢复已经完成最终选模，管线后续直接复用。
      if (prepareParent) pending = Promise.resolve(request);
      runLogger.debug(
        `[CompactModel] ${options.logLabel} returned model="${request.model}"`,
      );
    }
    return request;
  };
  let pending: Promise<CompressionRequestModel> | undefined;
  const resolve = () => (pending ??= select());
  let pendingParent: Promise<CompressionRequestModel> | undefined;
  return Object.assign(resolve, {
    prepareParent: () =>
      (pendingParent ??= (async () => {
        assertCurrent();
        return parent ?? select(true);
      })()),
  });
}
