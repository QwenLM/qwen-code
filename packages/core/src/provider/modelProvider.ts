/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelStreamRequest } from './modelStreamRequest.js';
import type { ModelStreamResponse } from './modelStreamResponse.js';
import type { ModelResolver } from './model/modelResolver.js';
import type { ModelSelector } from './model/modelSelector.js';
import type { ModelConfigurator } from './model/modelConfigurator.js';

/** providerId of the platform provider; its models carry it as `Model.source`. */
export const QODER_PROVIDER_ID = 'qoder';

export interface ModelProvider
  extends ModelSelector,
    ModelResolver,
    ModelConfigurator {
  readonly providerId: string;

  /**
   * 生命周期装载：构造只做纯内存绑定，读 settings / 预取清单等初始化数据
   * 的动作统一在 start() 内完成。幂等，可安全重复调用。
   */
  start(): Promise<void>;

  /** 生命周期卸载：与 start() 对称，释放自持资源；未 start 时调用是空操作。 */
  stop(): Promise<void>;

  inference(request: ModelStreamRequest): Promise<ModelStreamResponse>;
}
