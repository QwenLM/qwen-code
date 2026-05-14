/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  findDangerousAllowRules,
  isDangerousAgentRule,
  isDangerousAllowRule,
  isDangerousBashRule,
  isDangerousSkillRule,
} from './dangerousRules.js';
import { ToolNames } from '../tools/tool-names.js';
import type { PermissionRule } from './types.js';

function bashRule(specifier?: string): PermissionRule {
  return {
    raw: specifier ? `Bash(${specifier})` : 'Bash',
    toolName: ToolNames.SHELL,
    specifier,
  };
}

describe('isDangerousBashRule', () => {
  it('flags tool-level Bash (no specifier)', () => {
    expect(isDangerousBashRule(bashRule())).toBe(true);
  });

  it('flags Bash(*)', () => {
    expect(isDangerousBashRule(bashRule('*'))).toBe(true);
  });

  it('flags Bash() (empty specifier)', () => {
    expect(isDangerousBashRule(bashRule(''))).toBe(true);
  });

  it.each([
    'bash',
    'sh',
    'zsh',
    'fish',
    'python',
    'python3',
    'node',
    'deno',
    'bun',
    'ruby',
    'perl',
  ])('flags interpreter %s as bare name', (interp) => {
    expect(isDangerousBashRule(bashRule(interp))).toBe(true);
  });

  it.each(['python:*', 'node:*', 'bash:*'])(
    'flags interpreter prefix-form %s',
    (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    },
  );

  it.each(['python*', 'node*', 'bash*'])(
    'flags interpreter wildcard-form %s',
    (s) => {
      expect(isDangerousBashRule(bashRule(s))).toBe(true);
    },
  );

  it('flags python -c style command-line wildcards', () => {
    expect(isDangerousBashRule(bashRule('python -c *'))).toBe(true);
    expect(isDangerousBashRule(bashRule('node -e *'))).toBe(true);
  });

  it('does NOT flag specific safe commands', () => {
    expect(isDangerousBashRule(bashRule('git status'))).toBe(false);
    expect(isDangerousBashRule(bashRule('npm test'))).toBe(false);
    expect(isDangerousBashRule(bashRule('ls -la'))).toBe(false);
  });

  it('does NOT flag specific interpreter scripts', () => {
    // "python script.py" is a specific command, not an interpreter wildcard.
    expect(isDangerousBashRule(bashRule('python script.py'))).toBe(false);
  });

  it('is case-insensitive on the specifier', () => {
    expect(isDangerousBashRule(bashRule('PYTHON'))).toBe(true);
    expect(isDangerousBashRule(bashRule('NODE*'))).toBe(true);
  });

  it('returns false for non-Bash tools', () => {
    expect(
      isDangerousBashRule({
        raw: 'Read',
        toolName: ToolNames.READ_FILE,
      }),
    ).toBe(false);
  });
});

describe('isDangerousAgentRule', () => {
  it('flags any Agent allow rule regardless of specifier', () => {
    expect(
      isDangerousAgentRule({
        raw: 'Agent',
        toolName: ToolNames.AGENT,
      }),
    ).toBe(true);
    expect(
      isDangerousAgentRule({
        raw: 'Agent(coder)',
        toolName: ToolNames.AGENT,
        specifier: 'coder',
      }),
    ).toBe(true);
  });

  it('returns false for non-Agent tools', () => {
    expect(
      isDangerousAgentRule({ raw: 'Bash', toolName: ToolNames.SHELL }),
    ).toBe(false);
  });
});

describe('isDangerousSkillRule', () => {
  it('flags any Skill allow rule', () => {
    expect(
      isDangerousSkillRule({ raw: 'Skill', toolName: ToolNames.SKILL }),
    ).toBe(true);
    expect(
      isDangerousSkillRule({
        raw: 'Skill(pdf)',
        toolName: ToolNames.SKILL,
        specifier: 'pdf',
      }),
    ).toBe(true);
  });
});

describe('isDangerousAllowRule (aggregate)', () => {
  it('returns true for any dangerous category', () => {
    expect(isDangerousAllowRule(bashRule())).toBe(true);
    expect(
      isDangerousAllowRule({ raw: 'Agent', toolName: ToolNames.AGENT }),
    ).toBe(true);
    expect(
      isDangerousAllowRule({ raw: 'Skill', toolName: ToolNames.SKILL }),
    ).toBe(true);
  });

  it('returns false for safe rules', () => {
    expect(
      isDangerousAllowRule({
        raw: 'Read',
        toolName: ToolNames.READ_FILE,
      }),
    ).toBe(false);
    expect(isDangerousAllowRule(bashRule('git status'))).toBe(false);
  });
});

describe('findDangerousAllowRules', () => {
  it('returns only the dangerous subset', () => {
    const rules: PermissionRule[] = [
      bashRule('git status'), // safe
      bashRule('python'), // dangerous (interpreter)
      { raw: 'Read', toolName: ToolNames.READ_FILE }, // safe
      { raw: 'Agent', toolName: ToolNames.AGENT }, // dangerous (any Agent)
    ];
    const dangerous = findDangerousAllowRules(rules);
    expect(dangerous).toHaveLength(2);
    expect(dangerous.map((r) => r.toolName).sort()).toEqual(
      [ToolNames.AGENT, ToolNames.SHELL].sort(),
    );
  });

  it('returns empty array when input contains no dangerous rules', () => {
    const rules: PermissionRule[] = [
      bashRule('git log'),
      { raw: 'Read', toolName: ToolNames.READ_FILE },
    ];
    expect(findDangerousAllowRules(rules)).toEqual([]);
  });
});
