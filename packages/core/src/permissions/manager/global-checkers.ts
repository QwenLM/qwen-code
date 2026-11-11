/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createToolCheckerMap,
  type ToolCheckerRegistryDeps,
} from '../../tools/tool-checkers/checker-registry.js';
import type { HostToolChecker } from '../../tools/tool-checkers/rule-precedence.js';
import { parseMcpToolName } from '../../mcp/tools/mcp-names.js';
import { createNonInteractiveReadChecker } from './probe-checker.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../../tools/filesystem-permissions/internal-path-deps.js';
import { READ_FILE_TOOL_NAME } from '../../tools/tool-names.js';
import { getCwd } from '../../utils/Shell.js';

/**
 * 全局 checker 只依赖进程级事实；会话级事实（Skill、MCP 工具视图、技能规则）
 * 由每次判定的 ToolCheckContext 显式传入，表本身不捕获任何会话对象。
 */
export function createGlobalCheckerDeps(
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): ToolCheckerRegistryDeps {
  return {
    internalPaths,
    getShellReadOnlyContext: () => ({ cwd: getCwd() }),
    getSearchCwd: getCwd,
    skill: {
      isAllowedForMainSession: (name, ctx) =>
        ctx.skill?.isAllowedForMainSession(name, ctx) ??
        !(ctx.skillRules?.disabled?.has(name) ?? false),
      isDisabled: (name, ctx) =>
        ctx.skill?.isDisabled(name, ctx) ??
        (ctx.skillRules?.disabled?.has(name) ?? false),
      hasOnlySafeProperties: (name, ctx) =>
        ctx.skill?.hasOnlySafeProperties(name, ctx) ??
        (ctx.skillRules?.safeProperties?.has(name) ?? false),
    },
    mcpCall: {
      isKnownTool: (qualifiedName, ctx) =>
        ctx?.isMcpToolKnown?.(qualifiedName) === true,
      parseQualifiedName: parseMcpToolName,
    },
  };
}

export function createGlobalCheckerMap(
  scene: 'main' | 'probe',
  deps: ToolCheckerRegistryDeps = createGlobalCheckerDeps(),
  pluginCheckers: ReadonlyMap<string, HostToolChecker> = new Map(),
): Map<string, HostToolChecker> {
  const map = createToolCheckerMap(deps, pluginCheckers);
  if (scene === 'probe') {
    // Probe Read historically uses the standard Read checker, even when a
    // plugin overrides Main Read; retain its rule-only wrapper and no hooks.
    map.set(
      READ_FILE_TOOL_NAME,
      createNonInteractiveReadChecker(deps.internalPaths),
    );
  }
  return map;
}
