/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../model/model.js';

/** 协议请求体里与模型相关字段的取值规则，供各协议工厂共用。 */
export class ModelWireUtils {
  /**
   * 请求体 model 字段：key 带 `<source>/` 归属前缀（如自定义供应商的
   * `<providerId>/<modelId>`）时剥掉前缀，其余原样；modelId 自身可含 `/`。
   */
  static modelId(model: Model): string {
    const prefix = `${model.source}/`;
    return model.key.startsWith(prefix)
      ? model.key.slice(prefix.length)
      : model.key;
  }
}
