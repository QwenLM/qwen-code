/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from './model.js';

/** 目录读取控制；缓存保鲜策略由各 resolver 内部维护。 */
export interface ModelListOptions {
  /** 跳过内存读取，执行 IO 并更新内存快照。 */
  readonly skipCache?: boolean;
  /**
   * 只读内存快照，不触发刷新；快照缺失时返回空，由调用方自行降级。
   * 供不允许把目录请求带进关键路径的调用点使用（如 hook payload 解析）。
   * 与 `skipCache` 互斥，同时出现时以本项为准。
   */
  readonly cachedOnly?: boolean;
  /**
   * 按需追加的外部模型渠道（如 SDK 的 outerProviders）。只对支持渠道叠加的
   * resolver 生效，其余忽略；渠道目录的缓存策略由 resolver 内部维护。
   */
  readonly outerProviders?: readonly string[];
}

export interface ModelResolver {
  getModel(key: string): Promise<Model | undefined>;

  listModels(options?: ModelListOptions): Promise<Model[]>;
}
