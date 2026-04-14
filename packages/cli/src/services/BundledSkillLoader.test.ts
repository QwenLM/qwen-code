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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillManager = {
      listSkills: vi.fn().mockResolvedValue([]),
    };
    mockConfig = {
      getSkillManager: vi.fn().mockReturnValue(mockSkillManager),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue(undefined),
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

  it('should resolve {{model}} template variable in skill body', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}} via Qwen Code',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (mockConfig.getModel as ReturnType<typeof vi.fn>).mockReturnValue(
      'qwen3-coder',
    );

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
          text: 'YOUR_MODEL_ID="qwen3-coder"\n\nReview by qwen3-coder via Qwen Code',
        },
      ],
    });
  });

  it('should use empty string for {{model}} when getModel returns undefined', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}}',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    // getModel returns undefined (default mock behavior)

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'Review by ' }],
    });
  });

  it('should resolve {{model}} when args are provided', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}}',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (mockConfig.getModel as ReturnType<typeof vi.fn>).mockReturnValue(
      'qwen3-coder',
    );

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review 123', args: '123' } } as never,
      '123',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        {
          text: 'YOUR_MODEL_ID="qwen3-coder"\n\nReview by qwen3-coder\n\n/review 123',
        },
      ],
    });
  });

  it('should use empty string for {{model}} when getModel returns empty string', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}}',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (mockConfig.getModel as ReturnType<typeof vi.fn>).mockReturnValue('');

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'Review by ' }],
    });
  });

  it('should not modify skill body without {{model}} template', async () => {
    const skill = makeSkill({ body: 'No template here' });
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'No template here' }],
    });
  });

  it('should hide skills with cron allowedTools when cron is disabled', async () => {
    const skills = [
      makeSkill({ name: 'review', description: 'Review code' }),
      makeSkill({
        name: 'loop',
        description: 'Loop command',
        allowedTools: ['cron_create', 'cron_list', 'cron_delete'],
      }),
    ];
    mockSkillManager.listSkills.mockResolvedValue(skills);
    (mockConfig.isCronEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('review');
  });
});
