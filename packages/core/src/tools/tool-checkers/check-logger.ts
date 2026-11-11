/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One log line per tool check, at the outermost wrapper of every assembled
 * checker — main map, eager MCP, and each fork's restricted map. Forks enter
 * the check table differently, so the label names where the check happened;
 * reading the run log is enough to regress the fork permission surfaces.
 *
 * Only the verdict shape is logged (kind, decision point, attribution kind,
 * and the rule as written when a rule decided) — never the tool input.
 */

import { runLogger } from '../../utils/runLogger.js';
import type { HostToolChecker } from './rule-precedence.js';

export function withCheckLog(
  label: string,
  checker: HostToolChecker,
): HostToolChecker {
  return {
    async check(input, ctx) {
      const result = await checker.check(input, ctx);
      const point =
        result.kind === 'ask'
          ? result.reason.decisionPoint
          : result.extra?.decisionPoint;
      const attribution =
        result.kind === 'ask' ? result.reason.attribution.type : undefined;
      const rule =
        result.kind === 'ask' && result.reason.attribution.type === 'rule'
          ? result.reason.attribution.rule
          : undefined;
      const ruleText = rule
        ? rule.ruleValue.ruleContent === undefined
          ? rule.ruleValue.toolName
          : `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
        : undefined;
      runLogger.log(
        `[permission-check] ${label} mode=${ctx.mode} → ${result.kind}` +
          (point ? ` point=${point}` : '') +
          (attribution ? ` attribution=${attribution}` : '') +
          (ruleText ? ` rule=${JSON.stringify(ruleText)}` : ''),
      );
      return result;
    },
  };
}
