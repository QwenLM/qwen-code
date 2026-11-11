/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../../provider/model/model.js';
import type { ModelStrategy } from './types.js';

/**
 * 服务端模型与宿主注入的直连模型在通用 Model
 * 之上叠加的可选字段。core 不依赖产品包，按结构读取；任何 Model 都可
 * 直接赋给 {@link QoderListedModel}。
 */
export interface QoderModelFields {
  readonly isNew?: boolean;
  readonly tags?: readonly string[];
  /** 服务端来源桶（'system' / 'organization' 等）。 */
  readonly catalogSource?: string;
  readonly serverScene?: string;
  readonly outerProvider?: string;
  readonly format?: string;
  readonly strategies?: readonly ModelStrategy[];
  readonly icon?: string;
  /** 直连模型的连接材料（不含密钥字段的结构读取面）。 */
  readonly connection?: {
    readonly provider?: string;
    readonly model?: string;
    readonly type?: string;
    readonly url?: string;
    readonly format?: string;
  };
}

export type QoderListedModel = Model & QoderModelFields;

/** 直连模型：由平台 provider 列出且带连接材料。 */
export function isDirectConnectionModel(model: Model): boolean {
  return model.source === 'qoder' && 'connection' in model;
}

/** 服务端下发的模型（不含直连模型与 custom provider）。 */
export function isQwenServerModel(model: Model): boolean {
  return model.source === 'qoder' && !('connection' in model);
}

/** custom provider 模型：source 是 custom provider 的 providerId。 */
export function isCustomProviderModel(model: Model): boolean {
  return model.source !== 'qoder';
}
