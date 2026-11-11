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
import { createAgentToolChecker } from './agent-checker.js';
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

describe('agent tool check', () => {
  const checker = createAgentToolChecker('Agent');
  const input = { subagent_type: 'Explore' };

  it('allows by default: the agent\'s own calls are checked individually', async () => {
    const result = await checker.check(input, contextFor('Agent', rules()));
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe('agent.no_deny_rule.allow');
  });

  it('denies the named agent type', async () => {
    const ruleSet = rules({ deny: { userSettings: ['Agent(Explore)'] } });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('deny');
    expect(result.extra?.denialReason?.decisionPoint).toBe('agent.rule.deny');
  });

  it('leaves other agent types alone', async () => {
    const ruleSet = rules({ deny: { userSettings: ['Agent(Plan)'] } });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('allow');
  });

  it('defaults the type when the input omits it', async () => {
    const ruleSet = rules({ deny: { userSettings: ['Agent(general-purpose)'] } });
    const result = await checker.check({}, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('deny');
  });

  it('matches deny rules case-insensitively', async () => {
    const ruleSet = rules({ deny: { userSettings: ['Agent(EXPLORE)'] } });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('deny');
  });

  it('matches allow rules case-insensitively', async () => {
    const ruleSet = rules({ allow: { userSettings: ['Agent(EXPLORE)'] } });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('allow');
    expect(result.extra?.decisionPoint).toBe('agent.rule.allow');
  });

  it('asks when an ask rule matches, offering to remember the type', async () => {
    const ruleSet = rules({ ask: { userSettings: ['Agent(Explore)'] } });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('agent.rule.ask');
      expect(result.suggestions).toEqual([
        {
          type: 'addRules',
          destination: 'localSettings',
          rules: [{ toolName: 'Agent', ruleContent: 'Explore' }],
          behavior: 'allow',
        },
      ]);
    }
  });

  it('matches ask rules case-insensitively', async () => {
    const ruleSet = rules({ ask: { userSettings: ['Agent(explore)'] } });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('ask');
  });

  it('prefers deny over ask when both match', async () => {
    const ruleSet = rules({
      deny: { userSettings: ['Agent(Explore)'] },
      ask: { userSettings: ['Agent(Explore)'] },
    });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('deny');
  });

  it('prefers ask over allow when both match', async () => {
    const ruleSet = rules({
      ask: { userSettings: ['Agent(Explore)'] },
      allow: { userSettings: ['Agent(Explore)'] },
    });
    const result = await checker.check(input, contextFor('Agent', ruleSet));
    expect(result.kind).toBe('ask');
  });
});
