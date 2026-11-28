/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { makeFakeConfig } from '../../test-utils/config.js';
import { READ_ONLY_SUBAGENT_DISALLOWED_TOOLS } from '../../tools/tool-names.js';
import { PLAN_AGENT_NAME, PlanAgent } from './plan-agent.js';

describe('PlanAgent', () => {
  it.each([
    { shells: ['Bash'] },
    { shells: ['PowerShell'] },
    { shells: ['Bash', 'PowerShell'] },
    { shells: [] },
  ])('matches runtime shell availability: $shells', ({ shells }) => {
    const config = makeFakeConfig();
    const toolRegistry = {
      hasToolEnabled: (name: string) =>
        name === 'Read' || shells.includes(name),
      getAllTools: () => [
        { name: 'Read' },
        ...shells.map((name) => ({ name })),
      ],
    } as unknown as ToolRegistry;
    const prompt = PlanAgent(config).getSystemPrompt!({ config, toolRegistry });
    for (const shell of ['Bash', 'PowerShell']) {
      expect(prompt.includes(`Use ${shell} ONLY for read-only`)).toBe(
        shells.includes(shell),
      );
      expect(prompt.includes(`NEVER use ${shell} for:`)).toBe(
        shells.includes(shell),
      );
    }
    const bashRule = prompt
      .split('\n')
      .find((line) => line.includes('Use Bash ONLY'));
    const psRule = prompt
      .split('\n')
      .find((line) => line.includes('Use PowerShell ONLY'));
    if (bashRule) {
      expect(bashRule).toContain('ls, git status');
      expect(bashRule).not.toContain('Get-ChildItem');
    }
    if (psRule) {
      expect(psRule).toContain('Get-ChildItem');
      expect(psRule).toContain('Get-Content');
      expect(psRule).not.toMatch(/\b(ls|cat|head|tail|find)\b/);
    }
    expect(prompt).toContain('READ-ONLY MODE - NO FILE MODIFICATIONS');
  });

  it('declares a read-only planning agent with the shared blacklist', () => {
    const agent = PlanAgent(makeFakeConfig());

    expect(agent.name).toBe(PLAN_AGENT_NAME);
    expect(agent.description).toContain('implementation plans');
    expect(agent.modelConfig).toEqual({ model: 'inherit' });
    expect(agent.omitAgentsMd).toBe(true);
    expect(agent.omitGitStatus).toBe(true);
    // Blacklist-only design: no tools whitelist, inherit then remove.
    expect(agent.toolConfig).toBeUndefined();
    expect(agent.disallowedTools).toEqual([
      ...READ_ONLY_SUBAGENT_DISALLOWED_TOOLS,
    ]);
  });

  it('embeds the read-only prohibitions and shell rules in its prompt', () => {
    const prompt = PlanAgent(makeFakeConfig()).promptConfig?.systemPrompt;

    expect(prompt).toContain('READ-ONLY MODE - NO FILE MODIFICATIONS');
    expect(prompt).toContain('READ-ONLY planning task');
    expect(prompt).toContain(`   - Use Bash ONLY for read-only`);
    expect(prompt).toContain(`   - NEVER use Bash for:`);
    expect(prompt).toContain(
      'You CANNOT and MUST NOT write, edit, or modify any files',
    );
  });

  it('requires the critical-files section in its output contract', () => {
    const prompt = PlanAgent(makeFakeConfig()).promptConfig?.systemPrompt;

    expect(prompt).toContain('### Critical Files for Implementation');
    expect(prompt).toContain('step-by-step implementation strategy');
  });
});
