/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { READ_FILE_TOOL_NAME } from '../../tools/tool-names.js';
import { createReadToolChecker } from '../../tools/tool-checkers/checkers/read-checker.js';
import {
  withToolLevelRules,
  type HostToolChecker,
} from '../../tools/tool-checkers/rule-precedence.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../tools/filesystem-permissions/internal-path-deps.js';

/**
 * Read 是否可读的探针：只回答「内部读会不会被拒」，永不弹窗。
 *
 * ask 原样返回（由调用方的 canPrompt:false 流程收敛成 deny），这样写前
 * 预读能区分「硬拒绝」与「本来要询问」，不会替真实写入提前拒掉一次本可
 * 弹窗的读取。yolo 下普通 ask 放行；显式 ask 规则保持询问语义。
 */
export function createNonInteractiveReadChecker(
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): HostToolChecker {
  const ruleCheckedRead = withToolLevelRules(
    READ_FILE_TOOL_NAME,
    createReadToolChecker(internalPaths),
  );
  return {
    async check(input, context) {
      const result = await ruleCheckedRead.check(input, context);
      if (result.kind !== 'ask') return result;
      const explicitAsk =
        result.reason.attribution.type === 'rule' &&
        result.reason.attribution.rule.ruleBehavior === 'ask';
      return context.mode === 'yolo' && !explicitAsk
        ? { kind: 'allow' }
        : result;
    },
  };
}
