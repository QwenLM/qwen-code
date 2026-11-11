/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Model,
  ModelConfig,
  ReasoningEffortLevel,
} from '../model/model.js';

/**
 * 思考开关的判定规则，供各协议工厂共用，避免各自重算出现分叉。
 * 档位与思考模式的支持域校验归 select，这里只看配置与模型能力。
 */
export class ModelThinkingUtils {
  /** 配置显式关闭思考：档位为 none 或思考模式为 disabled，关闭优先于其余档位。 */
  static isDisabled(config: ModelConfig): boolean {
    return (
      config.reasoning?.effort === 'none' ||
      config.reasoning?.thinking?.type === 'disabled'
    );
  }

  /** 本次请求实际开启思考：模型支持思考且配置未显式关闭。 */
  static isEnabled(model: Model, config: ModelConfig): boolean {
    return (
      model.capabilities.reasoning.supported &&
      !ModelThinkingUtils.isDisabled(config)
    );
  }

  /**
   * 只收档位的协议（如 Responses）用的单一档位：显式关闭为 none，其次取显式档位，
   * 最后由固定预算推导；均缺省返回 undefined。
   */
  static resolveEffort(config: ModelConfig): ReasoningEffortLevel | undefined {
    if (ModelThinkingUtils.isDisabled(config)) return 'none';
    const reasoning = config.reasoning;
    if (reasoning?.effort !== undefined) {
      return reasoning.effort;
    }
    return reasoning?.thinking?.type === 'enabled'
      ? ModelThinkingUtils.effortFromBudget(reasoning.thinking.budgetTokens)
      : undefined;
  }

  /** 预算到档位的分段，与旧栈 reasoningEffortFromThinkingBudget 同界。 */
  private static effortFromBudget(budget: number): ReasoningEffortLevel {
    if (budget <= 0) return 'none';
    if (budget <= 1024) return 'low';
    if (budget <= 8192) return 'medium';
    if (budget <= 24576) return 'high';
    if (budget <= 49152) return 'xhigh';
    return 'max';
  }
}
