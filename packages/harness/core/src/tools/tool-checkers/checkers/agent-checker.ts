/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for spawning a subagent.
 *
 * Rules name the agent type — `Agent(Explore)` — and the default is to allow:
 * the agent's own tool calls are each checked on their own, so gating the spawn
 * as well would double-prompt.
 */

import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import { suggestAllow, type ToolPermissionReason } from '../checker-reasons.js';
import {
  checkContentRules,
  isManagedAsk,
  type HostToolChecker,
  type ToolPermissionResult,
} from '../rule-precedence.js';
import { stringField } from '../content-checkers.js';

/**
 * Rule content is matched against the agent type case-insensitively: users
 * write agent names in whatever casing they remember, and `Agent(Explore)`
 * must govern an `explore` spawn.
 */
export function createAgentToolChecker(toolName: string): HostToolChecker {
  return {
    check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ): ToolPermissionResult {
      const agentType = stringField(input, 'subagent_type') ?? 'general-purpose';
      const byContentRule = checkContentRules(
        toolName,
        ctx,
        (content) => content.toLowerCase() === agentType.toLowerCase(),
        {
          deny: 'agent.rule.deny',
          ask: 'agent.rule.ask',
          allow: 'agent.rule.allow',
        },
      );
      if (byContentRule) {
        // Only a local content ask may offer a reusable grant for the agent type.
        if (byContentRule.kind === 'ask' && !isManagedAsk(byContentRule)) {
          return {
            ...byContentRule,
            suggestions: [suggestAllow({ toolName, ruleContent: agentType })],
          };
        }
        return byContentRule;
      }

      return {
        kind: 'allow',
        extra: { decisionPoint: 'agent.no_deny_rule.allow' },
      };
    },
  };
}
