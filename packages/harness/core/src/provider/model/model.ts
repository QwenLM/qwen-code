/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type ReasoningEffortLevel =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

/**
 * Immutable description of one model.
 *
 * All model-intrinsic capabilities and limits have this single authority. It
 * deliberately carries no provider runtime state.
 *
 * NOTE: credential-free is NOT part of this contract. Direct-connection entries carry
 * their connection material (api key, url) directly on the model object, so
 * any consumer that serializes a Model for logs, catalogs, or remote
 * projections must strip `connection` itself when it must not leak secrets.
 * Endpoint capabilities themselves live on the provider config.
 */
/**
 * 一次选模的推理配置：select 产出（已合并、已按模型能力裁剪），inference
 * 原样消费，下游不得改写。也用作 select 入参的配置意图与按模型存储的偏好。
 */
export interface ModelConfig {
  /** 思考：强度、模式、历史思考回放。 */
  readonly reasoning?: ModelReasoningConfig;

  readonly context?: ModelContextConfig;
  /** 采样参数；缺省由服务端默认。 */
  readonly sampling?: ModelSamplingConfig;
}

export interface ModelReasoningConfig {
  readonly effort?: ReasoningEffortLevel;
  /** 思考模式；缺省按模型原生行为。 */
  readonly thinking?: ModelThinkingConfig;
  /** 后续轮次是否回放历史思考；缺省由服务端决定。 */
  readonly preserve?: boolean;
}

export interface ModelContextConfig {
  /** 上下文窗口档位（输入侧上限）。 */
  readonly contextWindow?: number;
  /** 单次输出 token 上限。 */
  readonly maxOutputTokens?: number;
}

export interface ModelSamplingConfig {
  readonly temperature?: number;
  /** 采样核分布截断。 */
  readonly topP?: number;
  /** 每步候选 token 数。 */
  readonly topK?: number;
  readonly stop?: readonly string[];
}

/** 思考模式：自适应、指定预算开启或显式关闭；预算为正整数。 */
export type ModelThinkingConfig =
  | { readonly type: 'adaptive' }
  | { readonly type: 'enabled'; readonly budgetTokens: number }
  | { readonly type: 'disabled' };

export interface Model {
  /** The providerId of the provider that owns and executes this model. */
  readonly source: string;
  readonly key: string;
  readonly displayName: string;
  /** False when the catalog knows the model but it cannot be selected. */
  readonly enabled?: boolean;
  /** Provider-declared default for its scene; at most one listed model sets it. */
  readonly isDefault?: boolean;
  readonly capabilities: {
    readonly tools: boolean;
    readonly vision: boolean;
    readonly reasoning: {
      /** Whether the model supports reasoning, including non-configurable reasoning. */
      readonly supported: boolean;
      /** Includes `none` when explicit thinking disablement is supported. */
      readonly supportedEfforts: readonly ReasoningEffortLevel[];
    };
    /** 可选上下文窗口档位，升序；单档时是事实不是选择。 */
    readonly contextWindows: ReadonlyArray<{
      /** 档位 token 容量，也是运行时生效值。 */
      tokens: number;
      /** 展示名（如 "200K"）；缺省由 UI 自行格式化。 */
      label?: string;
    }>;
  };
  readonly limits: {
    readonly maxContextTokens: number;
    readonly maxOutputTokens?: number;
  };
  /**
   * Provider/catalog-pinned default inference parameters, used when the user
   * has not explicitly picked an effort level or context window. Absent when
   * the source exposes no defaults.
   */
  readonly defaultModelConfig?: ModelConfig;
}
