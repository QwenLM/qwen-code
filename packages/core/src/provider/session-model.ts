/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { raceWithAbortSignal } from '../utils/abort-race.js';
import { ModelNotFoundError } from '../utils/httpErrors.js';
import type { ModelConfig } from './model/model.js';
import type { ModelSelection } from './model/modelSelection.js';
import type { ModelProviderManager } from './impl/modelProviderManager.js';

/** 将业务边界的模型 key 兑换为覆盖选择；不切换主模型，也不读取会话偏好。 */
export async function resolveModelSelectionOverride(
  manager: Pick<ModelProviderManager, 'getModel'>,
  key: string,
  config: ModelConfig = {},
): Promise<ModelSelection> {
  const model = await manager.getModel(key);
  if (!model) {
    throw new ModelNotFoundError(`Model '${key}' is unavailable.`, 404);
  }
  return { model, config };
}

/** 捕获请求身份；每个异步准备阶段结束后校验，阻止旧请求继续选模。 */
export function createModelRequestGuard(
  config: Pick<
    Config,
    | 'getModel'
    | 'getModelProviderManager'
    | 'getModelRequestIdentity'
    | 'getSessionId'
  >,
  signal?: AbortSignal,
): () => void {
  signal?.throwIfAborted();
  const key = config.getModel();
  const identity = config.getModelRequestIdentity();
  const sessionId = config.getSessionId();
  const manager = config.getModelProviderManager();
  return () => {
    signal?.throwIfAborted();
    if (
      key !== config.getModel() ||
      identity !== config.getModelRequestIdentity() ||
      sessionId !== config.getSessionId() ||
      manager !== config.getModelProviderManager()
    ) {
      throw new Error(
        'Session model changed while preparing ModelProvider selection.',
      );
    }
  };
}

/** Reconcile the session anchor after auth, CLI/resume selection, or a model switch. */
export async function synchronizeSessionModelProvider(
  config: Pick<
    Config,
    | 'getModel'
    | 'getModelProviderManager'
    | 'getModelRequestIdentity'
    | 'getSessionId'
    | 'isConfiguredCustomProviderModelKey'
  >,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const key = config.getModel();
  const assertCurrent = createModelRequestGuard(config, signal);
  const manager = config.getModelProviderManager();
  const models = await raceWithAbortSignal(manager.listModels(), signal);
  assertCurrent();
  // 已列举的官方模型参与本地声明判断，避免未启用的同 key 声明遮蔽它。
  const listed = models.find((entry) => entry.key === key);
  const owner = config.isConfiguredCustomProviderModelKey(key, listed)
    ? key.slice(0, key.indexOf('/'))
    : 'qoder';
  const model = models.find(
    (entry) => entry.key === key && entry.source === owner,
  );
  assertCurrent();
  if (!model) {
    throw new ModelNotFoundError(
      `Session model "${key}" is unavailable in ModelProvider.`,
      404,
    );
  }
  manager.setMainModel(model, false);
}
