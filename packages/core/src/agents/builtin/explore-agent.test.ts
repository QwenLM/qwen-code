/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { makeFakeConfig } from '../../test-utils/config.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { SHELL_TOOL_NAME, SKILL_TOOL_NAME } from '../../tools/tool-names.js';
import { ExploreAgent } from './explore-agent.js';

describe('ExploreAgent', () => {
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
    const prompt = ExploreAgent(config).getSystemPrompt!({
      config,
      toolRegistry,
    });
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

  it('uses PowerShell when it is the only exploration tool', () => {
    const config = makeFakeConfig();
    const registry = {
      hasToolEnabled: (name: string) => name === 'PowerShell',
      getAllTools: () => [{ name: 'PowerShell' }],
    } as unknown as ToolRegistry;
    const agent = ExploreAgent(config);
    expect(
      agent.getSystemPrompt?.({ config, toolRegistry: registry }),
    ).toContain('Use Get-ChildItem via PowerShell');
    expect(
      agent.getSystemPrompt?.({ config, toolRegistry: registry }),
    ).toContain('Use Select-String via PowerShell');
    expect(
      agent.getSystemPrompt?.({ config, toolRegistry: registry }),
    ).not.toContain('no usable exploration tools');
  });
  it('limits its declared use to locating code rather than broad analysis', () => {
    const agent = ExploreAgent(makeFakeConfig());

    expect(agent.description).toContain('Fast read-only search agent');
    expect(agent.description).toContain('Do NOT use it for code review');
    expect(agent.description).toContain('open-ended analysis');
    expect(agent.descriptionLean).toContain('broad fan-out searches');
    expect(agent.descriptionLean).toContain("it doesn't review or audit it");
    expect(agent.modelConfig).toEqual({ model: 'inherit' });
    expect(agent.omitAgentsMd).toBe(true);
    expect(agent.omitGitStatus).toBe(true);
  });

  it('routes search guidance to the shell when Glob and Grep are unavailable', () => {
    const config = makeFakeConfig();
    const prompt = ExploreAgent(config).getSystemPrompt?.({
      config,
      toolRegistry: {
        hasToolEnabled: (name: string) => name === SHELL_TOOL_NAME,
        getAllTools: () => [{ name: SHELL_TOOL_NAME }],
      } as unknown as ToolRegistry,
    });
    // POSIX names on every platform: the shell tool runs Git Bash on Windows.
    const [globCommand, grepCommand] = ['find', 'grep'];

    expect(prompt).toContain(
      `- Use ${globCommand} via ${SHELL_TOOL_NAME} for broad file pattern matching`,
    );
    expect(prompt).toContain(
      `- Use ${grepCommand} via ${SHELL_TOOL_NAME} for searching file contents with regex`,
    );

    // Recommended fallbacks must also appear in the allowed read-only list,
    // otherwise the prompt contradicts itself.
    const allowedCommands = prompt?.match(
      /ONLY for read-only operations \(([^)]*)\)/,
    )?.[1];
    expect(allowedCommands).toContain(globCommand);
    expect(allowedCommands).toContain(grepCommand);
  });

  it('does not recommend Read or Bash when those tools are unavailable', () => {
    const config = makeFakeConfig();
    const prompt = ExploreAgent(config).getSystemPrompt?.({
      config,
      toolRegistry: {
        hasToolEnabled: () => false,
        getAllTools: () => [],
      } as unknown as ToolRegistry,
    });

    expect(prompt).toContain('no usable exploration tools are available');
    expect(prompt).toContain('Do not claim to have searched the codebase');
    expect(prompt).not.toContain('You excel at thoroughly navigating');
    expect(prompt).not.toContain(`via ${SHELL_TOOL_NAME}`);
    expect(prompt).not.toContain(`- Use ${SHELL_TOOL_NAME} ONLY`);
    expect(prompt).not.toContain('- Use Read when');
  });

  it('does not treat a coordination-only tool as exploration capability', () => {
    const config = makeFakeConfig();
    const prompt = ExploreAgent(config).getSystemPrompt?.({
      config,
      toolRegistry: {
        hasToolEnabled: (name: string) => name === SKILL_TOOL_NAME,
        getAllTools: () => [{ name: SKILL_TOOL_NAME }],
      } as unknown as ToolRegistry,
    });

    expect(prompt).toContain('no usable exploration tools are available');
    expect(prompt).not.toContain('You excel at thoroughly navigating');
  });
});
