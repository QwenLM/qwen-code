/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Where the check table's four dependencies come from in a real session.
 *
 * `createToolCheckerMap` deliberately asks for these rather than reaching for a
 * `Config`: the checks are pure functions of a rule set plus these four answers,
 * and keeping it that way is what lets them be tested without a session. The cost
 * is that someone has to do the reaching, and this is that someone — the only file
 * in the permission surface that holds a `Config`.
 *
 * Every dependency is a live read, not a snapshot. The table is built once when
 * the session starts; the skills, the connected MCP servers and the transcript are
 * all things that change while it runs, and a check that consulted a snapshot from
 * startup would answer about a session that no longer exists.
 */

import type { Config } from '../config/config.js';
import { getCwd } from '../utils/Shell.js';
import type { ToolCheckerRegistryDeps } from '../tools/tool-checkers/checker-registry.js';
import type { SkillCheckerDeps } from '../tools/tool-checkers/content-checkers.js';
import type { SkillManager } from '../skills/skillManager.js';
import { normalizeMcpSegment, parseMcpToolName } from '../mcp/tools/mcp-names.js';
import { skillHasOnlySafeProperties } from '../tools/activate-skill.js';
import { composeMcpRuleName } from './manager/decision/index.js';
import {
  createMcpToolChecker,
  type McpToolIdentity,
} from '../tools/tool-checkers/checkers/mcp-checker.js';
import {
  withHookAsk,
  withToolLevelRules,
  type HostToolChecker,
} from '../tools/tool-checkers/rule-precedence.js';
import { withCheckLog } from '../tools/tool-checkers/check-logger.js';
import { buildClassifierToolLookup } from './permission-modes/auto/index.js';
import type { SessionClassifierInputs } from './permission-modes/auto/auto-classifier.js';
import {
  qwenInternalPathDeps,
  type InternalPathDeps,
} from '../tools/filesystem-permissions/internal-path-deps.js';

/** Auto 分类器的会话输入：主会话 transcript 与工具表。 */
export function createClassifierInputsForConfig(
  config: Config,
): SessionClassifierInputs {
  return {
    getMessages: () => config.getConversationMessages(),
    getToolLookup: () =>
      buildClassifierToolLookup((name) => {
        const tool = config.getToolRegistry().getTool(name);
        return tool as
          | { toClassifierInput(input: Record<string, unknown>): unknown }
          | undefined;
      }),
  };
}

/** 权限只消费 SkillManager 的三个视图；这里把管理器收窄成 checker 依赖。 */
export function toSkillCheckerDeps(
  skill: SkillManager | SkillCheckerDeps,
): SkillCheckerDeps {
  if (!('getSkill' in skill)) return skill;
  const skillManager = skill;
  return {
    isAllowedForMainSession: (skillName) =>
      skillManager.isSkillAllowedForMainSession(skillName),
    isDisabled: (skillName) =>
      skillManager.getSkill(skillName)?.disabled === true,
    hasOnlySafeProperties: (skillName) => {
      const skill = skillManager.getSkill(skillName);
      // A skill that cannot be found is not a safe skill. The check that
      // follows will refuse it by name, which is the right answer for a name
      // the session does not know.
      return skill ? skillHasOnlySafeProperties(skill) : false;
    },
  };
}

export function createCheckerDepsForConfig(
  config: Config,
  internalPaths: InternalPathDeps = qwenInternalPathDeps,
): ToolCheckerRegistryDeps {
  return {
    internalPaths,
    getSearchCwd: getCwd,
    getShellReadOnlyContext: () => ({
      cwd: getCwd(),
    }),
    skill: toSkillCheckerDeps(config.getSkillManager()),

    mcpCall: {
      // The registry is the wrong source: lazy mode unregisters the qualified
      // tools after locking, leaving only the meta tools behind, so a registry
      // lookup answers "unknown" for every tool the dispatcher can dispatch.
      // And it must be the manager's *lazy* discovery index, the same view the
      // dispatcher's execute reads: alwaysLoad tools are never dispatched
      // through `mcp_call`, so the full index would answer "known" for names
      // that a granted prompt then cannot run.
      isKnownTool: (qualifiedName) =>
        config
          .getMcpClientManager()
          ?.getLazyDiscoveredMcpToolByQualifiedName(qualifiedName) !==
        undefined,
      parseQualifiedName: parseMcpToolName,
    },

  };
}

/**
 * The check for one directly registered (eager) MCP tool. 这类 checker 随
 * 会话的 MCP 工具表变化实时进入会话表；它只做工具级规则与 hook 裁决，
 * 模式统一由会话的模式层落定。
 */
export function createEagerMcpToolChecker(
  identity: McpToolIdentity,
): HostToolChecker {
  const qualifiedName = composeMcpRuleName(
    normalizeMcpSegment(identity.serverName),
    normalizeMcpSegment(identity.toolName),
  );
  return withCheckLog(
    `mcp-eager ${qualifiedName}`,
    withHookAsk(withToolLevelRules(qualifiedName, createMcpToolChecker(identity))),
  );
}
