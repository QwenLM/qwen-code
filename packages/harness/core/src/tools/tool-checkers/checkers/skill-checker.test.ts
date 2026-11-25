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
import {
  normalizePluginMarketplaceMetadata,
  type SkillDefinition,
} from '@qwen-code/resource';
import { skillHasOnlySafeProperties } from '../../activate-skill.js';

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

  describe('permission checks with real Skill metadata', () => {
    const plainSkill: SkillDefinition = {
      name: 'review-pr',
      description: 'Review a pull request',
      location: '/repo/.qoder/skills/review-pr/SKILL.md',
      skillRoot: '/repo/.qoder/skills/review-pr',
      body: 'Review the changes.',
    };
    const marketplace = normalizePluginMarketplaceMetadata({
      marketSourceId: 'market',
      orgId: 'org',
      itemKind: 'plugin',
      marketItemId: 'review-plugin',
      displayName: 'Review Plugin',
      version: '1.0.0',
    });
    const resourceLocation = {
      base: 'project_config',
      relativePath: 'skills/review-pr/SKILL.md',
      softlink: false,
    };

    function checkerFor(skill: SkillDefinition) {
      return createSkillToolChecker('Skill', {
        isAllowedForMainSession: () => true,
        isDisabled: () => skill.disabled === true,
        hasOnlySafeProperties: () => skillHasOnlySafeProperties(skill),
      });
    }

    it.each<[string, Partial<SkillDefinition>]>([
      ['no metadata', {}],
      [
        'empty marketplace identity',
        { plugin: normalizePluginMarketplaceMetadata() },
      ],
      ['marketplace identity', { plugin: marketplace }],
      [
        'unknown resource location',
        { resourceLocation: { base: '', relativePath: '', softlink: '' } },
      ],
      ['file resource location', { resourceLocation }],
      ['both metadata fields', { plugin: marketplace, resourceLocation }],
    ])('auto-allows a plain Skill with %s', async (_name, metadata) => {
      const result = await checkerFor({ ...plainSkill, ...metadata }).check(
        { skill: plainSkill.name },
        contextFor('Skill', rules()),
      );

      expect(result.kind).toBe('allow');
      expect(result.extra?.decisionPoint).toBe('skill.safe_properties.allow');
    });

    it.each([
      ['hooks', { hooks: { PreToolUse: [{ command: 'echo hook' }] } }],
      ['tool grants', { allowedTools: ['Bash'] }],
      ['shell override', { shell: 'bash' }],
      ['an unknown capability', { futureCapability: true }],
    ])('still asks for a Skill with metadata and %s', async (_name, capability) => {
      const skill = {
        ...plainSkill,
        plugin: marketplace,
        resourceLocation,
        ...capability,
      } as SkillDefinition;
      const result = await checkerFor(skill).check(
        { skill: plainSkill.name },
        contextFor('Skill', rules()),
      );

      expect(result.kind).toBe('ask');
    });

    it('keeps explicit deny rules ahead of metadata-only auto-approval', async () => {
      const result = await checkerFor({
        ...plainSkill,
        plugin: marketplace,
        resourceLocation,
      }).check(
        { skill: plainSkill.name },
        contextFor(
          'Skill',
          rules({ deny: { policySettings: ['Skill(review-pr)'] } }),
        ),
      );

      expect(result.kind).toBe('deny');
    });
  });
});
