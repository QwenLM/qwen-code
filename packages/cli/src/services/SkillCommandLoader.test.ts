/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SkillCommandLoader } from './SkillCommandLoader.js';
import { CommandKind } from '../ui/commands/types.js';
import type { Config, SkillConfig } from '@qwen-code/qwen-code-core';

function makeSkill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'my-skill',
    description: 'My skill description',
    level: 'user',
    filePath: '/home/user/.qwen/skills/my-skill/SKILL.md',
    body: 'Skill body content.',
    ...overrides,
  };
}

describe('SkillCommandLoader', () => {
  let mockConfig: Config;
  let mockSkillManager: { listSkills: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillManager = {
      listSkills: vi.fn().mockResolvedValue([]),
    };
    mockConfig = {
      getSkillManager: vi.fn().mockReturnValue(mockSkillManager),
      getBareMode: vi.fn().mockReturnValue(false),
    } as unknown as Config;
  });

  const signal = new AbortController().signal;

  it('should return empty array when config is null', async () => {
    const loader = new SkillCommandLoader(null);
    expect(await loader.loadCommands(signal)).toEqual([]);
  });

  it('should return empty array when SkillManager is not available', async () => {
    const config = {
      getSkillManager: vi.fn().mockReturnValue(null),
      getBareMode: vi.fn().mockReturnValue(false),
    } as unknown as Config;
    const loader = new SkillCommandLoader(config);
    expect(await loader.loadCommands(signal)).toEqual([]);
  });

  it('should return empty array in bare mode', async () => {
    (mockConfig.getBareMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const loader = new SkillCommandLoader(mockConfig);
    expect(await loader.loadCommands(signal)).toEqual([]);
    expect(mockSkillManager.listSkills).not.toHaveBeenCalled();
  });

  it('should query user, project, and extension levels', async () => {
    const loader = new SkillCommandLoader(mockConfig);
    await loader.loadCommands(signal);
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({ level: 'user' });
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({
      level: 'project',
    });
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({
      level: 'extension',
    });
  });

  it('should load user skill as slash command with correct properties', async () => {
    const skill = makeSkill({ level: 'user' });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd.name).toBe('my-skill');
    expect(cmd.description).toBe('My skill description');
    expect(cmd.kind).toBe(CommandKind.SKILL);
    expect(cmd.source).toBe('skill-dir-command');
    expect(cmd.sourceLabel).toBe('User');
    expect(cmd.modelInvocable).toBe(true);
  });

  it('should load project skill with sourceLabel "Project"', async () => {
    const skill = makeSkill({ level: 'project' });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'project' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0].sourceLabel).toBe('Project');
    expect(commands[0].source).toBe('skill-dir-command');
    expect(commands[0].modelInvocable).toBe(true);
  });

  it('should submit skill body as prompt', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/my-skill', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'Skill body content.' }],
    });
  });

  it('should append raw invocation when args are provided', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/my-skill foo', args: 'foo' } } as never,
      'foo',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: 'Skill body content.\n\n/my-skill foo' }],
    });
  });

  it('should return empty array when listSkills throws', async () => {
    mockSkillManager.listSkills.mockRejectedValue(new Error('load failed'));
    const loader = new SkillCommandLoader(mockConfig);
    expect(await loader.loadCommands(signal)).toEqual([]);
  });

  describe('extension skills', () => {
    it('should be modelInvocable when description is present', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: 'Use tmux for interactive commands',
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(true);
      expect(commands[0].source).toBe('plugin-command');
      expect(commands[0].sourceLabel).toBe('Extension: superpowers-lab');
    });

    it('should be modelInvocable when whenToUse is present', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: '',
        whenToUse: 'Use when you need tmux',
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(true);
    });

    it('should NOT be modelInvocable when description and whenToUse are absent', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: '',
        whenToUse: undefined,
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(false);
    });

    it('should NOT be modelInvocable when disableModelInvocation is true, even with description', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: 'Some description',
        disableModelInvocation: true,
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(false);
    });

    it('should use "Extension: unknown" as sourceLabel when extensionName is absent', async () => {
      const skill = makeSkill({ level: 'extension', description: 'foo' });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].sourceLabel).toBe('Extension: unknown');
    });
  });

  describe('user/project skill disableModelInvocation', () => {
    it('user skill with disableModelInvocation:true should NOT be modelInvocable', async () => {
      const skill = makeSkill({ level: 'user', disableModelInvocation: true });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'user' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(false);
    });
  });

  it('should aggregate skills from all levels', async () => {
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) => {
        if (level === 'user')
          return Promise.resolve([
            makeSkill({ name: 'user-skill', level: 'user' }),
          ]);
        if (level === 'project')
          return Promise.resolve([
            makeSkill({ name: 'proj-skill', level: 'project' }),
          ]);
        if (level === 'extension')
          return Promise.resolve([
            makeSkill({
              name: 'ext-skill',
              level: 'extension',
              description: 'foo',
            }),
          ]);
        return Promise.resolve([]);
      },
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(3);
    expect(commands.map((c) => c.name)).toEqual([
      'user-skill',
      'proj-skill',
      'ext-skill',
    ]);
  });
});
