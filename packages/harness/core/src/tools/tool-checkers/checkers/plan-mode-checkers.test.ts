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
import {
  createEnterPlanModeToolChecker,
  createExitPlanModeToolChecker,
} from './plan-mode-checkers.js';
import type { ToolPermissionReason } from '../checker-reasons.js';

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

const noRules: PermissionRules = { allow: {}, deny: {}, ask: {} };

describe('enter plan mode tool check', () => {
  const checker = createEnterPlanModeToolChecker('EnterPlanMode');

  it('asks, and the ask is unskippable — plan entry is a mode change the user must see', async () => {
    const result = await checker.check({}, contextFor('EnterPlanMode', noRules));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution.type).toBe('interaction');
      expect(result.suggestions).toEqual([
        {
          type: 'addRules',
          destination: 'localSettings',
          rules: [{ toolName: 'EnterPlanMode' }],
          behavior: 'allow',
        },
      ]);
    }
  });

  it('still asks when a bare allow rule exists — allow is an endorsement applied outside the checker', async () => {
    const rules: PermissionRules = {
      allow: { userSettings: ['EnterPlanMode'] },
      deny: {},
      ask: {},
    };
    const result = await checker.check({}, contextFor('EnterPlanMode', rules));
    expect(result.kind).toBe('ask');
  });

  it('honors an ask rule', async () => {
    const rules: PermissionRules = {
      allow: {},
      deny: {},
      ask: { userSettings: ['EnterPlanMode'] },
    };
    const result = await checker.check({}, contextFor('EnterPlanMode', rules));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution.type).toBe('rule');
    }
  });

  it('honors a deny rule', async () => {
    const rules: PermissionRules = {
      allow: {},
      deny: { userSettings: ['EnterPlanMode'] },
      ask: {},
    };
    const result = await checker.check({}, contextFor('EnterPlanMode', rules));
    expect(result.kind).toBe('deny');
  });
});

describe('exit plan mode tool check', () => {
  const checker = createExitPlanModeToolChecker('ExitPlanMode');

  it('asks, and the ask is unskippable — the review prompt is the feature', async () => {
    const result = await checker.check({}, contextFor('ExitPlanMode', noRules));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution.type).toBe('interaction');
      expect(result.suggestions).toBeUndefined();
    }
  });

  it('honors a deny rule', async () => {
    const rules: PermissionRules = {
      allow: {},
      deny: { userSettings: ['ExitPlanMode'] },
      ask: {},
    };
    const result = await checker.check({}, contextFor('ExitPlanMode', rules));
    expect(result.kind).toBe('deny');
  });
});
