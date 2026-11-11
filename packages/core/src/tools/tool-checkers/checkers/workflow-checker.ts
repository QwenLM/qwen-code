/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission check for running a workflow.
 *
 * A workflow orchestrates subagents, so the default is to ask; the prompt
 * offers to remember this workflow.
 */

import type { ToolCheckContext } from '../../../permissions/manager/decision/index.js';
import { suggestAllow, type ToolPermissionReason } from '../checker-reasons.js';
import {
  checkContentRules,
  type HostToolChecker,
  type ToolPermissionResult,
} from '../rule-precedence.js';
import { workflowPermissionContent } from '../content-checkers.js';

export function createWorkflowToolChecker(toolName: string): HostToolChecker {
  return {
    check(
      input: Record<string, unknown>,
      ctx: ToolCheckContext<ToolPermissionReason>,
    ): ToolPermissionResult {
      const content = workflowPermissionContent(input);
      if (content) {
        const byContentRule = checkContentRules(
          toolName,
          ctx,
          (ruleContent) => ruleContent === content,
          {
            deny: 'workflow.rule.deny',
            ask: 'workflow.rule.ask',
            allow: 'workflow.rule.allow',
          },
        );
        if (byContentRule) {
          return byContentRule;
        }
      }

      return {
        kind: 'ask',
        reason: {
          message: content ? `Run workflow ${content}?` : 'Run this workflow?',
          attribution: { type: 'other', reason: 'no rule covers this workflow' },
          decisionPoint: 'workflow.no_rule.ask',
        },
        ...(content
          ? { suggestions: [suggestAllow({ toolName, ruleContent: content })] }
          : {}),
      };
    },
  };
}
