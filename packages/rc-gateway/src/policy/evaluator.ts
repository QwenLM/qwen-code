/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Policy, PolicyAction, PolicyRule } from './loader.js';
import { globMatch, matchesAny } from './glob.js';
import {
  parseTimeOfDay,
  isWithinTimeOfDay,
  parseExpiresAt,
  isExpired,
} from './conditions.js';

export interface ToolCallContext {
  tool: string;
  /** Canonicalized internally for argsGlob/pathGlob matching. */
  args?: unknown;
  originScope?: string;
  sessionTag?: string;
}

export interface PolicyDecision {
  action: PolicyAction;
  /**
   * What produced this decision: `'policy'` when a rule matched (including a rule
   * downgraded to prompt), `'default'` when no rule matched and the policy default
   * action was used. Distinguishes a matched id-less rule from the default
   * fall-through — `ruleId` cannot, since `id` is optional. Maps to the spec's
   * audit `decision_source` (the `'client'` value is emitted by the human-vote
   * route, not the evaluator).
   */
  source: 'policy' | 'default';
  /** Undefined for the default (no rule matched). */
  ruleId?: string;
  /** Carried for prompt decisions. */
  requireScope?: string;
  /** Carried for deny decisions. */
  reason?: string;
  /**
   * True when the matched rule carried a condition we could NOT evaluate — a
   * still-deferred field (`rule.maxPerWindow`) or a MALFORMED
   * `match.timeOfDay`/`rule.expiresAt` (unparseable HH:MM, bad IANA zone,
   * unparseable instant). Such an allow/deny is downgraded to prompt — we never
   * auto-decide on a constraint we could not evaluate. Well-formed timeOfDay /
   * expiresAt are now evaluated (false here): satisfied → real action,
   * unsatisfied → the rule does not match at all.
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
  if (m.tool !== undefined && !globMatch(m.tool, ctx.tool)) {
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
  // timeOfDay/expiresAt/maxPerWindow are handled by classifyConditions, after
  // this static match passes.
  return true;
}

/**
 * Classify a rule's time/quota conditions against `now` (called only after the
 * static {@link ruleMatches} has passed):
 *
 * - `'no-match'`: a well-formed condition is NOT satisfied (expired, or current
 *   time outside the timeOfDay window). The rule is dead → the evaluator skips
 *   it and falls through, exactly like a non-matching tool/argsGlob.
 * - `'unevaluable'`: a present condition could not be parsed (malformed
 *   timeOfDay / expiresAt) OR a still-deferred field (`maxPerWindow`) is
 *   present. The evaluator downgrades a non-prompt action to prompt.
 * - `'match'`: all present conditions are well-formed and satisfied → the rule
 *   applies with its real action.
 *
 * A definitive `'no-match'` ALWAYS wins over `'unevaluable'`: a dead /
 * out-of-window rule is skipped even if it also carries a malformed sibling
 * field, so we never prompt for a rule that does not actually apply.
 */
function classifyConditions(
  rule: PolicyRule,
  now: Date,
): 'no-match' | 'match' | 'unevaluable' {
  let unevaluable = false;

  // 1. expiresAt — definitively dead when in the past.
  if (rule.expiresAt !== undefined) {
    const expiresMs = parseExpiresAt(rule.expiresAt);
    if (expiresMs === null) {
      unevaluable = true;
    } else if (isExpired(expiresMs, now)) {
      return 'no-match';
    }
  }

  // 2. timeOfDay — definitively dead when current time is outside the window.
  //    Checked even if expiresAt was malformed, so a no-match (out-of-window)
  //    still wins over the unevaluable expiresAt sibling.
  if (rule.match.timeOfDay !== undefined) {
    const parsed = parseTimeOfDay(rule.match.timeOfDay);
    if (parsed === null) {
      unevaluable = true;
    } else if (!isWithinTimeOfDay(parsed, now)) {
      return 'no-match';
    }
  }

  // 3. maxPerWindow — still deferred (Phase 2b).
  if (rule.maxPerWindow !== undefined) {
    unevaluable = true;
  }

  return unevaluable ? 'unevaluable' : 'match';
}

/**
 * Map a proposed tool call to allow/deny/prompt by first match over rules
 * ordered `(priority desc, specificity desc, index asc)`. PURE: no I/O; the
 * clock is injected as `now` (defaults to the real wall-clock) so the result is
 * deterministic under a fixed `now` + fixed timezone. A matched rule whose
 * time/quota conditions are UNEVALUABLE (malformed timeOfDay/expiresAt, or a
 * deferred maxPerWindow) is downgraded to prompt (the safety invariant); a
 * well-formed-but-unsatisfied condition makes the rule not match (fall through).
 */
export function evaluate(
  policy: Policy,
  ctx: ToolCallContext,
  now: Date = new Date(),
): PolicyDecision {
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

    // Evaluate time/quota conditions. A definitive 'no-match' (expired /
    // out-of-window, well-formed) skips the rule BEFORE we decide an action.
    const status = classifyConditions(rule, now);
    if (status === 'no-match') continue;

    const unevaluable = status === 'unevaluable';

    if (unevaluable && rule.action !== 'prompt') {
      // SAFETY: never auto-allow/deny on a constraint we could not evaluate.
      return {
        action: 'prompt',
        source: 'policy',
        ruleId: rule.id,
        requireScope: rule.requireScope ?? policy.defaults.requireScope,
        usedDeferredField: true,
      };
    }

    return {
      action: rule.action,
      source: 'policy',
      ruleId: rule.id,
      requireScope: rule.requireScope,
      reason: rule.reason,
      usedDeferredField: unevaluable,
    };
  }

  return {
    action: policy.defaults.action,
    source: 'default',
    requireScope: policy.defaults.requireScope,
    usedDeferredField: false,
  };
}
