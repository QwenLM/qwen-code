/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { HostToolChecker } from '../rule-precedence.js';
import { checkPowerShellPermission } from '../../shell-permissions/powerShellPermissions.js';
import { POWERSHELL_TOOL_NAME } from '../../tool-names.js';
import type { ShellReadOnlyContext } from '../../shell-permissions/gitReadOnlySafety.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../filesystem-permissions/internal-path-deps.js';

export function createPowerShellToolChecker(
  getExecutionContext?: () => ShellReadOnlyContext,
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): HostToolChecker {
  return {
    async check(input, context) {
      const ctx = {
        ...context,
        internalPaths:
          context.internalPaths ?? internalPaths.resolve({ cwd: context.cwd }),
      };
      const { command } = input;
      if (typeof command !== 'string' || !command.trim()) {
        return {
          kind: 'deny',
          extra: {
            denialReason: {
              message: 'No PowerShell command was provided.',
              attribution: { type: 'other', reason: 'Missing command' },
            },
          },
        };
      }
      return checkPowerShellPermission(
        {
          command,
          executionCwd: getExecutionContext?.().cwd ?? ctx.cwd,
          permissionCwd: ctx.cwd,
        },
        ctx,
        POWERSHELL_TOOL_NAME,
      );
    },
  };
}
export const powerShellToolChecker = createPowerShellToolChecker();
