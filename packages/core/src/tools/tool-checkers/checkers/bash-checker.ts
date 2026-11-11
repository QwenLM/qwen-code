/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for the shell tools: Bash, and Monitor, which runs commands
 * too.
 *
 * Shell is the widest tool in the set: one string can name many commands, read
 * paths, write paths and nested executions. `shellPermissions.ts` owns that
 * analysis; this file is the entry point that applies tool-level rules first and
 * carries the tool's own name into the command-level matching, because a rule is
 * written against the tool it was granted for (`Bash(git:*)`). Monitor's rules
 * are written under its own name.
 */

import { resolve } from 'node:path';
import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import { checkShellPermission } from '../../shell-permissions/shellPermissions.js';
import type { ToolPermissionReason } from '../checker-reasons.js';
import {
  type HostToolChecker,
  type ToolPermissionResult,
} from '../rule-precedence.js';
import { SHELL_TOOL_NAME } from '../../tool-names.js';
import type { ShellReadOnlyContext } from '../../shell-permissions/gitReadOnlySafety.js';
import { initializeShellParsers } from '../../../utils/shell-utils.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../filesystem-permissions/internal-path-deps.js';

/**
 * Build the check for one shell-family tool. `monitor` runs commands too, and its
 * rules are written under its own name.
 */
export function createShellToolChecker(
  toolName: string,
  getReadOnlyContext?: () => ShellReadOnlyContext,
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): HostToolChecker {
  return {
    async check(
      input: Record<string, unknown>,
      context: ToolCheckContext<ToolPermissionReason>,
    ): Promise<ToolPermissionResult> {
      const ctx = {
        ...context,
        internalPaths:
          context.internalPaths ?? internalPaths.resolve({ cwd: context.cwd }),
      };
      const { command, dir_path: dirPath } = input;
      if (typeof command !== 'string' || command.length === 0) {
        // Fail closed: without a command string there is nothing to analyse, and
        // a shell call is arbitrary code.
        return {
          kind: 'deny',
          extra: {
            decisionPoint: 'shell.no_command.deny',
            denialReason: {
              message: 'No command was provided, so it cannot be checked.',
              attribution: {
                type: 'other',
                reason: 'shell call without a command',
              },
              denialKind: 'permission-rule',
              decisionPoint: 'shell.no_command.deny',
            },
          },
        };
      }

      // The boundary is the project root; only where the command runs follows
      // dir_path. Judging against the execution directory instead would let
      // `dir_path: ../..` widen the workspace.
      const permissionCwd = ctx.cwd;
      await initializeShellParsers();
      const readOnlyContext = getReadOnlyContext?.();
      const executionCwd =
        typeof dirPath === 'string' && dirPath.length > 0
          ? resolve(permissionCwd, dirPath)
          : (readOnlyContext?.cwd ?? permissionCwd);

      return checkShellPermission(
        { ...input, command, executionCwd, permissionCwd },
        ctx,
        toolName,
        readOnlyContext && { ...readOnlyContext, cwd: executionCwd },
      );
    },
  };
}

export const shellToolChecker = createShellToolChecker(SHELL_TOOL_NAME);
