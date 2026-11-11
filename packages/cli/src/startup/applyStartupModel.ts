/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FatalInputError,
  type Config,
  type Model,
  type ModelProviderManager,
} from '@qwen-code/core';

/** 解析启动输入；认证和模型准入由调用方及会话 manager 负责。 */
export async function resolveStartupModel(
  manager: ModelProviderManager,
  modelInput: string | undefined,
): Promise<Model | undefined> {
  if (modelInput === undefined) return undefined;
  const input = modelInput.trim();
  if (!input) throw new FatalInputError('--model must not be empty.');

  const models = await manager.listModels();
  const exact = models.filter((model) => model.key === input);
  const folded = input.toLowerCase();
  const matches = exact.length
    ? exact
    : models.filter((model) => model.key.toLowerCase() === folded);
  const candidates = matches.length
    ? matches
    : models.filter((model) => model.displayName.toLowerCase() === folded);

  if (candidates.length === 0) {
    // 产品可能从目录中过滤了无权限模型；保留 manager 的原始准入错误。
    await manager.getModel(input);
    throw new FatalInputError(
      `Unknown model "${input}". Run --list-models to see available models.`,
    );
  }
  if (candidates.length > 1) {
    throw new FatalInputError(
      `Ambiguous model "${input}". Specify a model key: ${candidates.map((model) => model.key).join(', ')}.`,
    );
  }
  const model = candidates[0];
  if (model.enabled === false) {
    throw new FatalInputError(`Model "${input}" is not available.`);
  }
  const resolved = await manager.getModel(model.key);
  if (!resolved || resolved.enabled === false) {
    throw new FatalInputError(`Model "${input}" is not available.`);
  }
  return resolved;
}

/** 启动编排持有一次性动作；认证刷新及中途 resume 不重放 CLI override。 */
export function createStartupModelApplier(
  modelInput: string | undefined,
): (config: Config) => Promise<void> {
  if (modelInput === undefined) return async () => {};
  let applied: Promise<void> | undefined;
  return (config) => {
    applied ??= (async () => {
      await resolveStartupModel(config.getModelProviderManager(), modelInput);
      // Config 的切模版本同时保护已校正或由用户切换的模型，不重放旧 CLI 选择。
      await config.reconcileModelWithListedModels({
        onInvalidCliModel: 'throw',
      });
    })().catch((error) => {
      applied = undefined;
      throw error;
    });
    return applied;
  };
}
