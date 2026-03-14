/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BundledSkillLoader } from './BundledSkillLoader.js';
import { CommandKind } from '../ui/commands/types.js';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';

function makeSkill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'review',
    description: 'Review code changes',
    level: 'bundled',
    filePath: '/bundled/review/SKILL.md',
    body: 'You are an expert code reviewer.',
    ...overrides,
  };
}

describe('BundledSkillLoader', () => {
  let mockConfig: Config;
  let mockSkillManager: {
    listSkills: ReturnType<typeof vi.fn>;
    loadSkill: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillManager = {
      listSkills: vi.fn().mockResolvedValue([]),
      loadSkill: vi.fn().mockResolvedValue(null),
    };
    mockConfig = {
      getSkillManager: vi.fn().mockReturnValue(mockSkillManager),
    } as unknown as Config;
  });

  const signal = new AbortController().signal;

  it('should return empty array when config is null', async () => {
    const loader = new BundledSkillLoader(null);
    const commands = await loader.loadCommands(signal);
    expect(commands).toEqual([]);
  });

  it('should return empty array when SkillManager is not available', async () => {
    const config = {
      getSkillManager: vi.fn().mockReturnValue(null),
    } as unknown as Config;
    const loader = new BundledSkillLoader(config);
    const commands = await loader.loadCommands(signal);
    expect(commands).toEqual([]);
  });

  it('should load bundled skills as slash commands', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('review');
    expect(commands[0].description).toBe('Review code changes');
    expect(commands[0].kind).toBe(CommandKind.SKILL);
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({
      level: 'bundled',
    });
  });

  it('should submit skill body as prompt without args', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    mockSkillManager.loadSkill.mockResolvedValue(skill);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'You are an expert code reviewer.' }],
    });
  });

  it('should append raw invocation when args are provided', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    mockSkillManager.loadSkill.mockResolvedValue(skill);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review 123', args: '123' } } as never,
      '123',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'You are an expert code reviewer.\n\n/review 123' }],
    });
  });

  it('should use resolved skill body when extends is present', async () => {
    const bundledSkill = makeSkill();
    const resolvedSkill = makeSkill({
      body: 'You are an expert code reviewer.\n\n### Agent 5: Custom\n\nCustom focus.',
      level: 'project',
    });
    mockSkillManager.listSkills.mockResolvedValue([bundledSkill]);
    mockSkillManager.loadSkill.mockResolvedValue(resolvedSkill);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        {
          text: 'You are an expert code reviewer.\n\n### Agent 5: Custom\n\nCustom focus.',
        },
      ],
    });
  });

  it('should fall back to bundled skill when loadSkill returns null', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    mockSkillManager.loadSkill.mockResolvedValue(null);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'You are an expert code reviewer.' }],
    });
  });

  it('should fall back to bundled skill when loadSkill throws', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    mockSkillManager.loadSkill.mockRejectedValue(
      new Error('Cannot extend: bundled skill "review" not found'),
    );

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'You are an expert code reviewer.' }],
    });
  });

  it('should return empty array when listSkills throws', async () => {
    mockSkillManager.listSkills.mockRejectedValue(new Error('load failed'));

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toEqual([]);
  });

  it('should load multiple bundled skills', async () => {
    const skills = [
      makeSkill({ name: 'review', description: 'Review code' }),
      makeSkill({ name: 'deploy', description: 'Deploy app' }),
    ];
    mockSkillManager.listSkills.mockResolvedValue(skills);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.name)).toEqual(['review', 'deploy']);
  });
});
