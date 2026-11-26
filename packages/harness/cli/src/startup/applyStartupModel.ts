/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { FatalInputError, type Config } from '@qwen-code/core';

/** 认证就绪后统一校正 CLI 与 settings 的启动模型；目录匹配与回退由 Config 承担。 */
export function createStartupModelApplier(
  modelInput: string | undefined,
): (config: Config) => Promise<void> {
  let applied: Promise<void> | undefined;
  return (config) => {
    applied ??= (async () => {
      if (modelInput !== undefined && !modelInput.trim()) {
        throw new FatalInputError('--model must not be empty.');
      }
      const models = await config.getModelProviderManager().listModels();
      await config.reconcileModelWithListedModels({
        modelsWereAwaited: models.length > 0,
      });
    })().catch((error) => {
      applied = undefined;
      throw error;
    });
    return applied;
  };
}
