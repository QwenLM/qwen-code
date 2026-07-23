/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import type { Policy, PolicyAction, PolicyRule } from './loader.js';
import { globMatch, matchesAny } from './glob.js';
import { matchesPathPattern } from '@qwen-code/qwen-code-core';
import {
  parseTimeOfDay,
  isWithinTimeOfDay,
  parseExpiresAt,
  isExpired,
} from './conditions.js';

export interface ToolCallContext {
  tool: string;
  /** Canonicalized internally for argsGlob matching. */
  args?: unknown;
  /**
   * Every path the call touches. Supplied by `frameToContext` in production and
   * by the explain CLI from `--path`. Absent → pathGlob rules cannot match.
   */
  paths?: string[];
  /** Operations the call implies, for `match.operation` narrowing. */
  operations?: string[];
  /** Anchors picomatch path matching; default to `process.cwd()` when absent. */
  projectRoot?: string;
  cwd?: string;
  originScope?: string;
  sessionTag?: string;
}

/**
 * A READ-ONLY view of the quota store for the evaluator: does rule `ruleId` have
 * room within its rolling window at `nowMs`? `untracked` = no known limit (no
 * store entry / id-less). The evaluator must NEVER mutate quota state — consuming
 * happens in the enforcer AFTER a successful allow vote (design.md:68).
 */
export interface QuotaOracle {
  state(ruleId: string, nowMs: number): 'room' | 'exhausted' | 'untracked';
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

/**
 * Path matching via core's picomatch-backed matcher: real `**` depth semantics
 * and path normalization, so an equivalent spelling (`./x`, `a/../x`) cannot
 * bypass a deny that the old hand-rolled glob would have missed.
 *
 * `filePath` is resolved against `cwd` first — `matchesPathPattern` normalizes
 * the PATTERN (via `path.join` internally) but only forward-slashes the
 * candidate, never collapsing `.`/`..` segments in it — so that collapsing
 * must happen here. Using the call's `cwd` for THIS resolution is correct: for
 * `run_shell_command` the daemon really does execute in `directory`, so a
 * relative candidate must resolve against it to name the file actually
 * touched.
 *
 * Pattern ANCHORING is a separate concern and MUST use `projectRoot`, never
 * `cwd`, as the 4th (anchor) argument to `matchesPathPattern`: `cwd` here
 * ultimately traces back to `rawInput.directory`/`rawInput.cwd` in
 * `frameToContext` — fields the MODEL supplies in its own tool call. If an
 * unprefixed pattern (e.g. `**\/.env*`) anchored to that model-controlled
 * value, the model could move the anchor and make a literal, unobfuscated
 * deny target silently mismatch (`path-mismatch`) on a call whose `directory`
 * simply differs from `projectRoot` — no path obfuscation needed. A policy
 * author writing `**\/.env*` means "anywhere in the project"; `src/auth/**`
 * means "relative to the project" — neither should move because the model
 * claimed a different working directory. `projectRoot` comes from the
 * daemon's own trusted capabilities, not from call arguments, so anchoring to
 * it cannot be steered by the model.
 *
 * A pattern picomatch rejects yields `false` — never an accidental match.
 */
function pathMatchesAny(
  spec: string | string[] | undefined,
  filePath: string,
  projectRoot: string,
  cwd: string,
): boolean {
  if (spec === undefined) return true;
  const resolved = path.resolve(cwd, filePath);
  const patterns = Array.isArray(spec) ? spec : [spec];
  for (const pattern of patterns) {
    try {
      // Anchor is ALWAYS projectRoot (trusted) — never the model-supplied cwd.
      if (matchesPathPattern(pattern, resolved, projectRoot, projectRoot)) {
        return true;
      }
    } catch {
      // Unusable pattern → not a match.
    }
  }
  return false;
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
  if (m.operation !== undefined) w += 30;
  if (m.originScope !== undefined) w += 20;
  if (m.timeOfDay !== undefined && m.timeOfDay !== null) w += 20;
  if (m.sessionTag !== undefined) w += 20;
  return w;
}

/**
 * Why a rule's STATIC match fails, or `null` when it matches. The single source
 * of truth for both {@link ruleMatches} (the hot-path boolean — a `null` check,
 * with NO string allocation on the matching branch) and {@link explainPolicy}'s
 * SKIPPED reason token, so the two can never disagree.
 */
function matchReason(
  rule: PolicyRule,
  ctx: ToolCallContext,
  argString: string,
  paths: string[],
): string | null {
  const m = rule.match;
  // tool glob (absent → no constraint).
  if (m.tool !== undefined && !globMatch(m.tool, ctx.tool)) {
    return 'tool-mismatch';
  }
  // argsGlob (undefined → matchesAny returns true).
  if (!matchesAny(m.argsGlob, argString)) return 'args-mismatch';
  // pathGlob: present but zero candidate paths → no match.
  if (m.pathGlob !== undefined) {
    if (paths.length === 0) return 'no-path-candidates';
    const root = ctx.projectRoot ?? process.cwd();
    const cwd = ctx.cwd ?? root;
    if (!paths.some((p) => pathMatchesAny(m.pathGlob, p, root, cwd))) {
      return 'path-mismatch';
    }
  }
  // operation (absent → no constraint). Pure AND, like every other dimension:
  // it can only ever NARROW a rule.
  if (m.operation !== undefined) {
    const want = Array.isArray(m.operation) ? m.operation : [m.operation];
    const have = ctx.operations ?? [];
    if (!want.some((o) => have.includes(o))) return 'operation-mismatch';
  }
  // originScope / sessionTag exact (absent → no constraint).
  if (m.originScope !== undefined && m.originScope !== ctx.originScope) {
    return 'origin-scope-mismatch';
  }
  if (m.sessionTag !== undefined && m.sessionTag !== ctx.sessionTag) {
    return 'session-tag-mismatch';
  }
  // timeOfDay/expiresAt/maxPerWindow are handled by classifyConditions, after
  // this static match passes.
  return null;
}

function ruleMatches(
  rule: PolicyRule,
  ctx: ToolCallContext,
  argString: string,
  paths: string[],
): boolean {
  return matchReason(rule, ctx, argString, paths) === null;
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
/** A condition classification plus a short reason token (for explain). */
interface ConditionResult {
  kind: 'no-match' | 'match' | 'unevaluable';
  /** Reason token; `''` when `kind === 'match'`. */
  reason: string;
}

/**
 * The detailed form of {@link classifyConditions}: also reports WHY (a token),
 * for the explain trace. The FIRST unevaluable cause wins the reason; a
 * definitive `no-match` (well-formed-but-unsatisfied) still short-circuits and
 * wins over any unevaluable sibling.
 */
function classifyConditionsDetailed(
  rule: PolicyRule,
  now: Date,
  quota?: QuotaOracle,
): ConditionResult {
  let unevaluable = false;
  let unevaluableReason = 'condition-unevaluable';

  // 1. expiresAt — definitively dead when in the past.
  if (rule.expiresAt !== undefined) {
    const expiresMs = parseExpiresAt(rule.expiresAt);
    if (expiresMs === null) {
      unevaluable = true;
      unevaluableReason = 'malformed-expiresAt';
    } else if (isExpired(expiresMs, now)) {
      return { kind: 'no-match', reason: 'expired' };
    }
  }

  // 2. timeOfDay — definitively dead when current time is outside the window.
  //    Checked even if expiresAt was malformed, so a no-match (out-of-window)
  //    still wins over the unevaluable expiresAt sibling.
  if (rule.match.timeOfDay !== undefined) {
    const parsed = parseTimeOfDay(rule.match.timeOfDay);
    if (parsed === null) {
      if (!unevaluable) unevaluableReason = 'malformed-timeOfDay';
      unevaluable = true;
    } else if (!isWithinTimeOfDay(parsed, now)) {
      return { kind: 'no-match', reason: 'outside-time-window' };
    }
  }

  // 3. maxPerWindow — consult the quota oracle when one is supplied (the enforcer
  //    path). Without an oracle, or for an id-less rule (can't be tracked), it
  //    stays unevaluable → prompt (the backward-compatible default).
  if (rule.maxPerWindow !== undefined) {
    if (quota && rule.id !== undefined) {
      const q = quota.state(rule.id, now.getTime());
      if (q === 'exhausted') {
        // An exhausted rule does NOT apply — wins over any unevaluable sibling.
        return { kind: 'no-match', reason: 'quota-exhausted' };
      }
      if (q === 'untracked') {
        if (!unevaluable) unevaluableReason = 'quota-not-evaluated';
        unevaluable = true;
      }
      // 'room' → the quota condition is satisfied; do NOT clear a prior
      // unevaluable (a malformed expiresAt sibling must still force prompt).
    } else {
      if (!unevaluable) unevaluableReason = 'quota-not-evaluated';
      unevaluable = true;
    }
  }

  return unevaluable
    ? { kind: 'unevaluable', reason: unevaluableReason }
    : { kind: 'match', reason: '' };
}

function classifyConditions(
  rule: PolicyRule,
  now: Date,
  quota?: QuotaOracle,
): 'no-match' | 'match' | 'unevaluable' {
  return classifyConditionsDetailed(rule, now, quota).kind;
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
/**
 * Rule indices in evaluation order: `priority desc, specificity desc, index
 * asc`. Shared by {@link evaluate} and {@link explainPolicy} so the trace order
 * is provably the evaluation order.
 */
function orderedRuleIndices(policy: Policy): number[] {
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
  return order;
}

export function evaluate(
  policy: Policy,
  ctx: ToolCallContext,
  now: Date = new Date(),
  quota?: QuotaOracle,
): PolicyDecision {
  const argString = canonicalArgString(ctx.args);
  const paths = ctx.paths ?? [];

  for (const idx of orderedRuleIndices(policy)) {
    const rule = policy.rules[idx];
    if (!ruleMatches(rule, ctx, argString, paths)) continue;

    // Evaluate time/quota conditions. A definitive 'no-match' (expired /
    // out-of-window, well-formed) skips the rule BEFORE we decide an action.
    const status = classifyConditions(rule, now, quota);
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

/** One rule's annotation in a {@link PolicyExplanation} trace. */
export interface RuleTrace {
  /** Original index in `policy.rules` (the trace array itself is in eval order). */
  index: number;
  id?: string;
  status: 'matched' | 'skipped' | 'not-reached';
  /**
   * Short reason token. For `skipped`: why the rule did not apply
   * (`tool-mismatch`, `args-mismatch`, `path-mismatch`, `no-path-candidates`,
   * `operation-mismatch`, `origin-scope-mismatch`, `session-tag-mismatch`,
   * `expired`, `outside-time-window`, `quota-exhausted`). For `matched`: either
   * `matched` or the unevaluable cause that downgraded it to prompt
   * (`malformed-expiresAt`, `malformed-timeOfDay`, `quota-not-evaluated`). For
   * `not-reached`: `earlier-rule-won`.
   */
  reason: string;
  /** The action this rule contributes as the winner (`matched` only). */
  action?: PolicyAction;
  /** True when matched but downgraded to prompt by an unevaluable condition. */
  downgraded?: boolean;
  /**
   * True when this matched winner carries a `maxPerWindow` whose quota was NOT
   * consulted (no oracle / id-less / untracked) — the daemon-free dry-run case.
   * Set INDEPENDENTLY of the reason token (which a malformed sibling field can
   * win), so the renderer's quota caveat is never wrongly suppressed. The live
   * quota could change this rule's runtime outcome (its real action while it has
   * room; skipped once exhausted).
   */
  quotaNotEvaluated?: boolean;
}

/** Result of {@link explainPolicy}: the authoritative decision + per-rule trace. */
export interface PolicyExplanation {
  /** The REAL decision from {@link evaluate} — can never drift from the trace. */
  decision: PolicyDecision;
  /** Rules in evaluation order (priority desc, specificity desc, index asc). */
  trace: RuleTrace[];
}

/**
 * Dry-run a policy and produce a per-rule trace — the `qwen rc policy explain`
 * inspector. PURE. Walks rules in the SAME order as {@link evaluate} via
 * {@link orderedRuleIndices}, reusing the SAME {@link matchReason} /
 * {@link classifyConditionsDetailed} internals, and computes the authoritative
 * `decision` by CALLING `evaluate` — so the printed decision can never diverge
 * from what the enforcer would do. Without a {@link QuotaOracle} (the
 * daemon-free CLI), a `maxPerWindow` rule is `unevaluable` → prompt; pass an
 * oracle to reflect live quota state.
 */
export function explainPolicy(
  policy: Policy,
  ctx: ToolCallContext,
  now: Date = new Date(),
  quota?: QuotaOracle,
): PolicyExplanation {
  const argString = canonicalArgString(ctx.args);
  const paths = ctx.paths ?? [];
  const trace: RuleTrace[] = [];
  let winnerFound = false;

  for (const idx of orderedRuleIndices(policy)) {
    const rule = policy.rules[idx];
    if (winnerFound) {
      trace.push({
        index: idx,
        id: rule.id,
        status: 'not-reached',
        reason: 'earlier-rule-won',
      });
      continue;
    }
    const mm = matchReason(rule, ctx, argString, paths);
    if (mm !== null) {
      trace.push({ index: idx, id: rule.id, status: 'skipped', reason: mm });
      continue;
    }
    const cc = classifyConditionsDetailed(rule, now, quota);
    if (cc.kind === 'no-match') {
      trace.push({
        index: idx,
        id: rule.id,
        status: 'skipped',
        reason: cc.reason,
      });
      continue;
    }
    // Winner: the first rule that statically matches with a non-no-match
    // condition. A non-prompt action with an unevaluable condition is
    // downgraded to prompt — exactly as evaluate() does.
    const downgraded = cc.kind === 'unevaluable' && rule.action !== 'prompt';
    // A maxPerWindow whose quota we could not consult here (no oracle / id-less
    // / untracked). Computed independently of `cc.reason` so a malformed sibling
    // field winning the reason slot doesn't hide that the quota was unevaluated.
    const quotaNotEvaluated =
      rule.maxPerWindow !== undefined &&
      (!quota ||
        rule.id === undefined ||
        quota.state(rule.id, now.getTime()) === 'untracked');
    trace.push({
      index: idx,
      id: rule.id,
      status: 'matched',
      reason: cc.kind === 'unevaluable' ? cc.reason : 'matched',
      action: downgraded ? 'prompt' : rule.action,
      downgraded,
      ...(quotaNotEvaluated ? { quotaNotEvaluated: true } : {}),
    });
    winnerFound = true;
  }

  return { decision: evaluate(policy, ctx, now, quota), trace };
}
