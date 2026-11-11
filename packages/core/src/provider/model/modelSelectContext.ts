/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model, ModelConfig, ReasoningEffortLevel } from './model.js';
import type { ModelSelection } from './modelSelection.js';

export interface RequestModelOverride {
  /** 省略时按业务用途选择模型，只覆盖本次配置。 */
  key?: string;
  config?: ModelConfig;
}

export interface ModelPolicyInput {
  sessionId: string;
  turnIndex: number;
  agentId?: string;
  agentType?: string;
  cumulativeUsage?: { input_tokens: number; output_tokens: number };
  retry?: { attempt: number; lastError: string; lastModelId: string };
}

/** Workload category for one model-selection decision. */
export type ModelPurpose =
  | 'main'
  | 'side_question'
  | 'fork'
  | 'plan'
  | 'task'
  | 'compact'
  | 'auto_permission'
  | 'insights'
  | 'title'
  | 'summary'
  | 'suggestion'
  | 'generate'
  | 'hook_prompt'
  | 'web_fetch';

/**
 * select 入参，调用方直接构造。
 *
 * 不含消息、工具、凭据或传输信息；选模只在主模型锚定的 provider 候选池内完成。
 */
export interface ModelSelectContext {
  /** 业务用途；会话 selector 将旁问和 fork 映射到原有基础选模用途。 */
  readonly purpose: ModelPurpose;

  /** 会话主模型：调用方可省略，由 Manager 在委派 Provider 前补齐，以会话锚点为准。 */
  readonly mainModel?: Model;

  /** 锚点：父请求的选择（子任务、compact、hook、fork 继承）。 */
  readonly parentSelection?: ModelSelection;

  readonly overrideSelection?: ModelSelection | RequestModelOverride;

  /** 循环调整所依据的当前选择；没有 adjustment 时不作为复用入口。 */
  readonly modelResolution?: ModelSelection;

  /** 循环中的业务变化；调整时 modelResolution 是当前选择。 */
  readonly adjustment?:
    | { readonly kind: 'skill-model'; readonly key: string }
    | { readonly kind: 'skill-effort'; readonly effort: ReasoningEffortLevel }
    | { readonly kind: 'output-limit'; readonly maxOutputTokens: number };

  /** 仅原本参与宿主策略的请求提供；普通工具选模不隐式触发宿主。 */
  readonly request?: ModelPolicyInput;
  readonly signal?: AbortSignal;
}

/** 手动压缩可先准备父选择，最终选模仍由压缩管线按需触发。 */
export interface CompactModelSelectContext extends ModelSelectContext {
  readonly purpose: 'compact';
  /** 压缩摘要专用：复用准备阶段已完成的选择，不重复执行准备规则或 SDK 策略。 */
  readonly compactSelection?: ModelSelection;
  /** 没有父快照时的原始模型名与显式配置，不包含模型补齐的默认值。 */
  readonly parentOverride?: RequestModelOverride & { key: string };
  readonly prepareParent?: true;
}
