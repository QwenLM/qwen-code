/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission checks for entering and exiting plan mode.
 *
 * Plan entry is a mode change the user should see: asks once, and the prompt
 * offers to allow the tool from then on. (A mode that never prompts refuses
 * the entry instead — the mode layer carries that message.)
 *
 * Plan exit is a review: the prompt is the feature, nothing is offered to
 * remember, and only a deny rule can stop the call.
 */

import {
  alwaysAskChecker,
  askWithSelfAllowChecker,
  type HostToolChecker,
} from '../rule-precedence.js';

export function createEnterPlanModeToolChecker(
  toolName: string,
): HostToolChecker {
  // unskippable：进入 plan 模式是用户要看到的模式变化，任何模式都要弹窗。
  return askWithSelfAllowChecker(
    toolName,
    'Allow entering plan mode?',
    'enter_plan_mode.no_rule.ask',
    { unskippable: true },
  );
}

export function createExitPlanModeToolChecker(
  toolName: string,
): HostToolChecker {
  return alwaysAskChecker(toolName, 'Review the plan before leaving plan mode.');
}
