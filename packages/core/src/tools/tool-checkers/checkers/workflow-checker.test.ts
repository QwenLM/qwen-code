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
import { createWorkflowToolChecker } from './workflow-checker.js';
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

describe('workflow tool check', () => {
  const checker = createWorkflowToolChecker('Workflow');

  it('asks by default and offers to remember the workflow', async () => {
    const result = await checker.check(
      { name: 'nightly' },
      contextFor('Workflow', rules()),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('workflow.no_rule.ask');
      expect(result.suggestions?.length).toBe(1);
    }
  });

  it('matches the name exactly', async () => {
    const ruleSet = rules({ allow: { localSettings: ['Workflow(nightly)'] } });
    expect(
      (await checker.check({ name: 'nightly' }, contextFor('Workflow', ruleSet)))
        .kind,
    ).toBe('allow');
    expect(
      (
        await checker.check(
          { name: 'nightly-2' },
          contextFor('Workflow', ruleSet),
        )
      ).kind,
    ).toBe('ask');
  });

  it('asks without a suggestion when the workflow has no identity', async () => {
    const result = await checker.check({}, contextFor('Workflow', rules()));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.suggestions).toBeUndefined();
    }
  });
});
