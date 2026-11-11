/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../../../permissions/manager/decision/index.js';
import { createSkillToolChecker } from './skill-checker.js';
import type { ToolPermissionReason } from '../checker-reasons.js';

function rules(overrides: Partial<PermissionRules> = {}): PermissionRules {
  return { allow: {}, deny: {}, ask: {}, ...overrides };
}

function contextFor(
  toolName: string,
  ruleSet: PermissionRules,
): ToolCheckContext<ToolPermissionReason> {
  return {
    mode: PermissionModes.Default,
    rules: ruleSet,
    cwd: '/repo',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(ruleSet, toolName),
    toolUseId: 'tu-1',
  };
}

describe('skill tool check', () => {
  const checker = createSkillToolChecker('Skill', {
    isAllowedForMainSession: () => true,
    isDisabled: () => false,
    hasOnlySafeProperties: () => false,
  });

  it('asks by default and offers to remember this skill', async () => {
    const result = await checker.check(
      { skill: 'review-pr' },
      contextFor('Skill', rules()),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.message).toBe('Activate skill review-pr?');
      expect(result.suggestions).toEqual([
        expect.objectContaining({
          rules: [{ toolName: 'Skill', ruleContent: 'review-pr' }],
          behavior: 'allow',
        }),
      ]);
    }
  });

  it('allows via a prefix rule', async () => {
    const ruleSet = rules({ allow: { localSettings: ['Skill(review:*)'] } });
    const result = await checker.check(
      { skill: 'review-pr' },
      contextFor('Skill', ruleSet),
    );
    expect(result.kind).toBe('allow');
  });

  it('lets deny outrank a matching allow', async () => {
    const ruleSet = rules({
      allow: { localSettings: ['Skill(review:*)'] },
      deny: { policySettings: ['Skill(review-pr)'] },
    });
    const result = await checker.check(
      { skill: 'review-pr' },
      contextFor('Skill', ruleSet),
    );
    expect(result.kind).toBe('deny');
  });

  it('refuses a call with no skill name', async () => {
    const result = await checker.check({}, contextFor('Skill', rules()));
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('skill.no_name.deny');
  });

  it('normalizes the name: trims it and drops a leading slash', async () => {
    const ruleSet = rules({ allow: { localSettings: ['Skill(review-pr)'] } });
    for (const written of ['review-pr', ' review-pr ', '/review-pr']) {
      const result = await checker.check(
        { skill: written },
        contextFor('Skill', ruleSet),
      );
      expect(result.kind).toBe('allow');
    }
  });

  it('refuses a skill outside the main session allowlist, outranking an allow rule', async () => {
    const gated = createSkillToolChecker('Skill', {
      isAllowedForMainSession: () => false,
      isDisabled: () => false,
      hasOnlySafeProperties: () => false,
    });
    const ruleSet = rules({ allow: { localSettings: ['Skill(review-pr)'] } });
    const result = await gated.check(
      { skill: 'review-pr' },
      contextFor('Skill', ruleSet),
    );
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('skill.not_allowlisted.deny');
  });

  it('does not apply the main session allowlist to a subagent', async () => {
    const gated = createSkillToolChecker('Skill', {
      isAllowedForMainSession: () => false,
      isDisabled: () => false,
      hasOnlySafeProperties: () => false,
    });
    const result = await gated.check(
      { skill: 'review-pr' },
      { ...contextFor('Skill', rules()), agentId: 'agent-1' },
    );
    expect(result.kind).toBe('ask');
  });

  it('refuses a disabled skill before an allow rule can admit it', async () => {
    // Settings can remove a skill from the visible list; the model may still
    // remember its name. The gate is ahead of the rules for exactly that.
    const gated = createSkillToolChecker('Skill', {
      isAllowedForMainSession: () => true,
      isDisabled: () => true,
      hasOnlySafeProperties: () => true,
    });
    const ruleSet = rules({ allow: { localSettings: ['Skill(review-pr)'] } });
    const result = await gated.check(
      { skill: 'review-pr' },
      contextFor('Skill', ruleSet),
    );
    expect(result.kind).toBe('deny');
    expect(result.extra?.decisionPoint).toBe('skill.disabled.deny');
  });

  it('allows a skill that declares only safe properties', async () => {
    const safe = createSkillToolChecker('Skill', {
      isAllowedForMainSession: () => true,
      isDisabled: () => false,
      hasOnlySafeProperties: () => true,
    });
    const result = await safe.check(
      { skill: 'review-pr' },
      contextFor('Skill', rules()),
    );
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe('skill.safe_properties.allow');
  });

  it('lets a deny rule outrank the safe-properties allowance', async () => {
    const safe = createSkillToolChecker('Skill', {
      isAllowedForMainSession: () => true,
      isDisabled: () => false,
      hasOnlySafeProperties: () => true,
    });
    const ruleSet = rules({ deny: { policySettings: ['Skill(review-pr)'] } });
    const result = await safe.check(
      { skill: 'review-pr' },
      contextFor('Skill', ruleSet),
    );
    expect(result.kind).toBe('deny');
  });
});
