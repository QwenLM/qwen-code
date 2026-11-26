/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { mergeRuleOverlay } from '../../permissions/manager/decision/config-snapshot.js';
import type { CheckPermissionOptions } from '../../permissions/manager/decision/index.js';
import type { ToolPermissionReason } from '../tool-checkers/checker-reasons.js';
import type { Config } from '../../config/config.js';
import type { ToolUseContext } from '../tool-types.js';
import type { ToolResult } from '../tools.js';
import { ToolErrorType } from '../tool-error.js';
import { withToolLevelRules } from '../tool-checkers/rule-precedence.js';
import {
  checkManagedReadPaths,
  checkReadPermissionForPath,
} from './filesystem.js';

/** One confirmation covers the protected results of this search, never future calls. */
export async function confirmManagedSearchRead(
  paths: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
  ctx: ToolUseContext,
  config: Config,
): Promise<ToolResult | undefined> {
  if (!paths.length) return undefined;
  const owner = ctx.agentLoopContext ?? config;
  const permission = owner.permission;
  const rules = permission?.getManagedRules();
  if (!permission || !rules || (!rules.deny.length && !rules.ask.length))
    return undefined;
  const permissionContext = ctx.agentLoopContext?.permissionContext?.();
  const options: CheckPermissionOptions<ToolPermissionReason> | undefined =
    permissionContext
      ? {
          ...(permissionContext.rules !== undefined
            ? {
                rules: permissionContext.additionalRules
                  ? mergeRuleOverlay(
                      permissionContext.rules,
                      permissionContext.additionalRules,
                    )
                  : permissionContext.rules,
              }
            : { additionalRules: permissionContext.additionalRules }),
          permissionMode: permission.resolveMode(permissionContext.mode),
          ...(permissionContext.canPrompt === false
            ? { askHandler: async () => ({ kind: 'rejected' as const }) }
            : {}),
          additionalDirectories: permissionContext.additionalDirectories
            ? [...permissionContext.additionalDirectories]
            : undefined,
        }
      : undefined;
  const cwd = options?.cwd ?? config.getTargetDir();
  const context = {
    rules: options?.rules ?? permission.getRules(),
    additionalDirectories:
      options?.additionalDirectories ?? permission.getAdditionalDirectories(),
    globalRules: rules,
  };
  const current = checkManagedReadPaths(paths, context, cwd);
  if (!current) return undefined;

  const checker = withToolLevelRules(toolName, {
    check: (_checkedInput, checkedContext) => {
      for (const path of paths) {
        const result = checkReadPermissionForPath(
          path,
          checkedContext,
          checkedContext.cwd,
        );
        if (result.kind === 'deny') return result;
      }
      // 搜索根已授权；这里补上具体结果，且不得跳过新的托管 ask 或本地 deny。
      return (
        checkManagedReadPaths(paths, checkedContext, checkedContext.cwd) ?? {
          kind: 'allow',
        }
      );
    },
  });
  const originalInput = structuredClone(input);
  const decision = await permission.checkWithChecker(
    {
      toolName,
      input,
      toolUseId: ctx.callId ?? 'search-read-results',
      agentId: ctx.agentId,
      signal: ctx.signal,
    },
    checker,
    {
      ...options,
      cwd,
      preToolUseHookVerdict: undefined,
    },
  );
  if (
    decision.kind === 'allow' &&
    isDeepStrictEqual(decision.input, originalInput)
  )
    return undefined;
  const message =
    decision.denialMessage ??
    decision.reason?.message ??
    'Search results require approval under the current permission policy. Please retry.';
  return {
    llmContent: message,
    returnDisplay: message,
    error: { type: ToolErrorType.PERMISSION_DENIED, message },
  };
}
