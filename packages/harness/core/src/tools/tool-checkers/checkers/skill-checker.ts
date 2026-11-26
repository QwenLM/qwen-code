/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for activating a skill.
 *
 * A skill can carry instructions, hooks and tool grants, so the default is to
 * ask — the prompt offers to remember this skill by name.
 */

import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import { suggestAllow, type ToolPermissionReason } from '../checker-reasons.js';
import {
  checkContentRules,
  type HostToolChecker,
  type ToolPermissionResult,
} from '../rule-precedence.js';
import {
  skillRuleMatches,
  stringField,
  type SkillCheckerDeps,
} from '../content-checkers.js';

/**
 * Activating a skill. A skill can carry instructions, hooks and tool grants,
 * so the default is to ask — the prompt offers to remember this skill by name.
 */
export function createSkillToolChecker(
  toolName: string,
  deps: SkillCheckerDeps,
): HostToolChecker {
  return {
    check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ): ToolPermissionResult {
      const raw = stringField(input, 'skill') ?? stringField(input, 'name');
      if (!raw) {
        return {
          kind: 'deny',
          extra: {
            decisionPoint: 'skill.no_name.deny',
            denialReason: {
              message: 'No skill name was provided, so it cannot be checked.',
              attribution: {
                type: 'other',
                reason: 'skill call without a name',
              },
              denialKind: 'permission-rule',
              decisionPoint: 'skill.no_name.deny',
            },
          },
        };
      }
      // Users write both `review` and `/review`.
      const trimmed = raw.trim();
      const skillName = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;

      // Settings can disable a skill; the model may still remember its name.
      // Refuse before the allowlist, rules, or any approval can admit it.
      if (deps.isDisabled(skillName, ctx)) {
        const message = `Skill "${skillName}" is unavailable.`;
        return {
          kind: 'deny',
          extra: {
            decisionPoint: 'skill.disabled.deny',
            denialReason: {
              message,
              attribution: { type: 'other', reason: message },
              denialKind: 'permission-rule',
              decisionPoint: 'skill.disabled.deny',
            },
          },
        };
      }

      // The main session's allowlist is a hard gate: a skill outside it is not
      // approvable, so it is refused before any rule can allow it. Subagents run
      // with their own skill set and are not subject to it.
      const isMainSession = ctx.agentId === undefined;
      if (isMainSession && !deps.isAllowedForMainSession(skillName, ctx)) {
        const message = `Skill "${skillName}" is not in this session's skills allowlist`;
        return {
          kind: 'deny',
          extra: {
            decisionPoint: 'skill.not_allowlisted.deny',
            denialReason: {
              message,
              attribution: { type: 'other', reason: message },
              denialKind: 'permission-rule',
              decisionPoint: 'skill.not_allowlisted.deny',
            },
          },
        };
      }

      const byContentRule = checkContentRules(
        toolName,
        ctx,
        (content) => skillRuleMatches(content, skillName),
        {
          deny: 'skill.rule.deny',
          ask: 'skill.rule.ask',
          allow: 'skill.rule.allow',
        },
      );
      if (byContentRule) {
        return byContentRule;
      }

      if (deps.hasOnlySafeProperties(skillName, ctx)) {
        return {
          kind: 'allow',
          extra: { decisionPoint: 'skill.safe_properties.allow' },
        };
      }

      return {
        kind: 'ask',
        reason: {
          message: `Activate skill ${skillName}?`,
          attribution: { type: 'other', reason: 'no rule covers this skill' },
          decisionPoint: 'skill.no_rule.ask',
        },
        suggestions: [suggestAllow({ toolName, ruleContent: skillName })],
      };
    },
  };
}
