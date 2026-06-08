/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Policy, PolicyAction, PolicyRule } from './loader.js';
import { globToRegExp, matchesAny } from './glob.js';

export interface ToolCallContext {
  tool: string;
  /** Canonicalized internally for argsGlob/pathGlob matching. */
  args?: unknown;
  originScope?: string;
  sessionTag?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  /** Undefined for the default (no rule matched). */
  ruleId?: string;
  /** Carried for prompt decisions. */
  requireScope?: string;
  /** Carried for deny decisions. */
  reason?: string;
  /**
   * True when the matched rule used a deferred (unevaluated) field
   * (`match.timeOfDay`, `rule.maxPerWindow`, or `rule.expiresAt`). Such an
   * allow/deny is downgraded to prompt — we never auto-decide on a constraint
   * this cycle does not evaluate.
   */
  usedDeferredField: boolean;
}

/** Whitespace-collapsed canonical form of the call args for argsGlob matching. */
function canonicalArgString(args: unknown): string {
  const raw = typeof args === 'string' ? args : JSON.stringify(args ?? '');
  return raw.replace(/\s+/g, ' ').trim();
}

/** Collect candidate path strings from object args (path, cwd, files[]). */
function candidatePaths(args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  const obj = args as Record<string, unknown>;
  const out: string[] = [];
  if (typeof obj['path'] === 'string') out.push(obj['path']);
  if (typeof obj['cwd'] === 'string') out.push(obj['cwd']);
  if (Array.isArray(obj['files'])) {
    for (const f of obj['files']) {
      if (typeof f === 'string') out.push(f);
    }
  }
  return out;
}

/** Specificity weight per the design's table (Decisions §5). */
function specificity(rule: PolicyRule): number {
  const m = rule.match;
  let w = 0;
  if (m.tool !== undefined) {
    if (m.tool === '*') w += 10;
    else if (m.tool.includes('*')) w += 90;
    else w += 100;
  }
  if (m.argsGlob !== undefined) w += 30;
  if (m.pathGlob !== undefined) w += 30;
  if (m.originScope !== undefined) w += 20;
  if (m.timeOfDay !== undefined && m.timeOfDay !== null) w += 20;
  if (m.sessionTag !== undefined) w += 20;
  return w;
}

function ruleMatches(
  rule: PolicyRule,
  ctx: ToolCallContext,
  argString: string,
  paths: string[],
): boolean {
  const m = rule.match;
  // tool glob (absent → no constraint).
  if (m.tool !== undefined && !globToRegExp(m.tool).test(ctx.tool)) {
    return false;
  }
  // argsGlob (undefined → matchesAny returns true).
  if (!matchesAny(m.argsGlob, argString)) return false;
  // pathGlob: present but zero candidate paths → no match.
  if (m.pathGlob !== undefined) {
    if (paths.length === 0) return false;
    if (!paths.some((p) => matchesAny(m.pathGlob, p))) return false;
  }
  // originScope / sessionTag exact (absent → no constraint).
  if (m.originScope !== undefined && m.originScope !== ctx.originScope) {
    return false;
  }
  if (m.sessionTag !== undefined && m.sessionTag !== ctx.sessionTag) {
    return false;
  }
  // timeOfDay/expiresAt/maxPerWindow are deferred → treated as satisfied.
  return true;
}

/**
 * Map a proposed tool call to allow/deny/prompt by first match over rules
 * ordered `(priority desc, specificity desc, index asc)`. PURE: no I/O, no
 * clock dependence. A matched allow/deny rule using a deferred field is
 * downgraded to prompt (the safety invariant).
 */
export function evaluate(policy: Policy, ctx: ToolCallContext): PolicyDecision {
  const argString = canonicalArgString(ctx.args);
  const paths = candidatePaths(ctx.args);

  const order = policy.rules.map((_, i) => i);
  order.sort((a, b) => {
    const ra = policy.rules[a];
    const rb = policy.rules[b];
    const pa = ra.priority ?? 0;
    const pb = rb.priority ?? 0;
    if (pa !== pb) return pb - pa;
    const wa = specificity(ra);
    const wb = specificity(rb);
    if (wa !== wb) return wb - wa;
    return a - b;
  });

  for (const idx of order) {
    const rule = policy.rules[idx];
    if (!ruleMatches(rule, ctx, argString, paths)) continue;

    const usedDeferred = !!(
      rule.match.timeOfDay ||
      rule.maxPerWindow ||
      rule.expiresAt
    );

    if (usedDeferred && rule.action !== 'prompt') {
      // SAFETY: never auto-allow/deny on an unevaluated time/quota constraint.
      return {
        action: 'prompt',
        ruleId: rule.id,
        requireScope: rule.requireScope ?? policy.defaults.requireScope,
        usedDeferredField: true,
      };
    }

    return {
      action: rule.action,
      ruleId: rule.id,
      requireScope: rule.requireScope,
      reason: rule.reason,
      usedDeferredField: usedDeferred,
    };
  }

  return {
    action: policy.defaults.action,
    requireScope: policy.defaults.requireScope,
    usedDeferredField: false,
  };
}
