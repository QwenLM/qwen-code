/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createPermissionModes } from '../permissions/manager/permission-manager.js';
import type { ModeResolveContext } from '../permissions/manager/types.js';
import type { HostToolChecker } from '../tools/tool-checkers/rule-precedence.js';

const modes = createPermissionModes({
  getRules: () => ({ allow: {}, deny: {}, ask: {} }),
  getModeRestriction: () => undefined,
  dispose: () => {},
});

/** Run existing checker fixtures through the real Permission mode definitions. */
export function checkInPermissionMode(
  checker: HostToolChecker,
  options: Pick<
    ModeResolveContext,
    'coveredByAcceptEdits' | 'autoClassifier'
  > = {},
): HostToolChecker {
  return {
    async check(input, ctx) {
      const result = await checker.check(input, ctx);
      if (result.kind !== 'ask') return result;
      return modes[ctx.mode].resolve(result, {
        ...options,
        mode: ctx.mode,
        toolName: 'TestTool',
        input,
        rules: ctx.rules,
        agentId: ctx.agentId,
        signal: ctx.signal,
        toolCheckContext: ctx,
      });
    },
  };
}
