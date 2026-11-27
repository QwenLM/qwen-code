/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model, ModelConfig } from './model.js';

/**
 * 每模型偏好的读写面：用户为某个模型显式选定的推理参数（effort /
 * thinking / contextWindow 等），键为 Model.key。
 *
 * 持久化语义固定为 user scope settings 的 model.preferences[key]——这是
 * 该类偏好的唯一磁盘落点，读写两侧形状对称：setModelConfig 只覆盖 patch
 * 里显式给出的字段，未写入的字段保留原值，显式 undefined 清除该字段以恢复模型默认；
 * getModelConfig 未配置过返回 undefined，由调用方回落 defaultModelConfig
 * 再回落模型能力默认。与 Model 契约解耦：偏好是易变的用户态，不进目录
 * 对象，也不进 provider 的清单缓存。
 */
export interface ModelConfigurator {
  /** 读某模型 persist 后的偏好；未配置过返回 undefined。 */
  getModelConfig(model: Model): ModelConfig | undefined;

  /**
   * 合并写入某模型的偏好：只覆盖 patch 里显式给出的字段。默认只改本次
   * 会话内存态；persist 为 true 时同步落盘到实现方对应的 settings scope。
   * 写失败不得抛出中断调用方；返回 false 表示未保存。
   */
  setModelConfig(model: Model, patch: ModelConfig, persist?: boolean): boolean;
}
