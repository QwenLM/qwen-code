/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from './model.js';
import type { ModelConfig } from './model.js';

/**
 * Immutable answer produced by one model-selection operation.
 *
 * A resolution only names the model: the provider that executes it is never
 * part of the answer — a provider must be anchored first, and the model is
 * then solved inside that provider's own candidate pool. Request messages,
 * tools, credentials, transport targets, and routing implementation details
 * do not belong here.
 */
export interface ModelSelection {
  readonly model: Model;
  /** 最终配置：已合并、已裁剪。下游只读。 */
  readonly config: ModelConfig;
}

export interface ModelPolicyLabels {
  taskId?: string;
  subTask?: string;
}

export interface ModelSelectResult extends ModelSelection {
  /** 本次原样复用了父快照或兼容结果，没有重新选模。 */
  reusedSelection?: true;
  /** 只完成了压缩父选择准备，尚未执行最终压缩策略。 */
  preparedParentOnly?: true;
  /** 本地压缩路由失败后复用父选择，保留调用方原有来源归因。 */
  fallbackToParent?: true;
  /** 存在表示本次执行过宿主策略，空 labels 也不能误用旧标签。 */
  policy?: { labels?: ModelPolicyLabels; overridden: boolean };
}
