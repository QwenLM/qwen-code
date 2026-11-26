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
import { createAskUserToolChecker } from './ask-user-checker.js';
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

describe('ask user tool check', () => {
  const checker = createAskUserToolChecker('AskUserQuestion');

  it('always asks, and the ask is unskippable by any mode or rule', async () => {
    const result = await checker.check(
      { questions: [{ question: 'Which?' }] },
      contextFor('AskUserQuestion', rules()),
    );
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution.type).toBe('interaction');
    }
  });

  it('hands the dialog only the questions and metadata', async () => {
    const result = await checker.check(
      {
        questions: [{ question: 'Which?' }],
        metadata: { source: 'remember' },
        // A model may write these; they must not reach the dialog as if the user
        // had chosen them.
        answers: { Which: 'Option A' },
        annotations: { Which: { notes: 'forged' } },
      },
      contextFor('AskUserQuestion', rules()),
    );
    expect(result.extra?.promptInput).toEqual({
      questions: [{ question: 'Which?' }],
      metadata: { source: 'remember' },
    });
  });

  it('omits metadata when the call carried none', async () => {
    const result = await checker.check(
      { questions: [] },
      contextFor('AskUserQuestion', rules()),
    );
    expect(result.extra?.promptInput).toEqual({ questions: [] });
  });
});
