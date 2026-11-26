/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared judgement primitives for the content-based tool checkers.
 *
 * The tools whose rules key on one value — which agent, which skill, which
 * workflow, which URL — are the same shape: derive the key from the input,
 * then match rule contents against it. That derivation and matching live here;
 * each tool assembles its own check flow in its own file under `checkers/`.
 * The matching is the tool's own business: `Skill(review:*)` covering
 * `review-pr` is a skill convention, and a URL matching a bare hostname is a
 * WebFetch one.
 */

import type { ToolCheckContext } from '../../permissions/manager/decision/index.js';
import type { ToolPermissionReason } from './checker-reasons.js';

/** Extract a non-empty string field from a tool input. */
export function stringField(
  input: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = input[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Whether a skill rule's content covers this skill name. A leading slash is
 * ignored so `Skill(/review)` and `Skill(review)` mean the same, and a trailing
 * `:*` makes the rule a prefix.
 */
export function skillRuleMatches(
  ruleContent: string,
  skillName: string,
): boolean {
  const normalized = ruleContent.startsWith('/')
    ? ruleContent.slice(1)
    : ruleContent;

  if (normalized === skillName) {
    return true;
  }
  if (normalized.endsWith(':*')) {
    return skillName.startsWith(normalized.slice(0, -2));
  }
  return false;
}

/**
 * What the skill check needs from the skill registry. Supplied at registration
 * so the check itself stays free of the skill subsystem.
 */
export interface SkillCheckerDeps {
  /** Whether this session's allowlist admits the skill at all. */
  isAllowedForMainSession(
    skillName: string,
    ctx: ToolCheckContext<ToolPermissionReason>,
  ): boolean;
  /**
   * Whether settings disabled the skill. A disabled skill is refused before any
   * rule can allow it — the model may remember a name the settings removed.
   */
  isDisabled(
    skillName: string,
    ctx: ToolCheckContext<ToolPermissionReason>,
  ): boolean;
  /**
   * Whether the skill declares nothing that can act on its own — no hooks, no
   * tool grants. Such a skill is only instructions, so it needs no prompt.
   */
  hasOnlySafeProperties(
    skillName: string,
    ctx: ToolCheckContext<ToolPermissionReason>,
  ): boolean;
}

/** A workflow is identified by its name, or by the script path when unnamed. */
export function workflowPermissionContent(
  input: Record<string, unknown>,
): string | undefined {
  return stringField(input, 'name') ?? stringField(input, 'scriptPath');
}

/**
 * The rule keys a URL can match: its hostname, and the hostname with its path.
 * An unparseable URL matches nothing.
 */
export function webFetchRuleCandidates(url: string): string[] {
  try {
    const parsed = new URL(url);
    const candidates = [parsed.hostname];
    if (parsed.pathname && parsed.pathname !== '/') {
      candidates.push(`${parsed.hostname}${parsed.pathname}`);
    }
    return candidates;
  } catch {
    return [];
  }
}
