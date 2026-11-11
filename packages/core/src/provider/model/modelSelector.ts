/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig } from './model.js';
import type {
  ModelSelection,
  ModelSelectResult,
  ModelPolicyLabels,
} from './modelSelection.js';
import type {
  ModelSelectContext,
  ModelPolicyInput,
  RequestModelOverride,
} from './modelSelectContext.js';

export interface ModelSelector {
  /** 统一选模上下文；会话锚点由 Manager 委派前补齐。 */
  select(context: ModelSelectContext): Promise<ModelSelectResult>;
}

/** 读取 Agent 定义配置及可用的登记模型；不保存本次 query 的覆盖要求。 */
export type ReadAgentSelectionDefaults = (
  request: Pick<ModelPolicyInput, 'agentId' | 'agentType'>,
  purpose?: 'task' | 'fork',
) => RequestModelOverride | undefined;

export type ModelSelectionPolicy = (
  context: ModelSelectContext,
  baseSelection: ModelSelection | undefined,
) => Promise<
  | {
      key?: string;
      config?: ModelConfig;
      labels?: ModelPolicyLabels;
    }
  | undefined
>;

export type PrepareModelSelection = (
  input: ModelSelectContext,
) => Promise<ModelSelectContext>;
