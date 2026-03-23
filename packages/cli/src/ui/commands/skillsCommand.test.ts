/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import type { SkillConfig } from '@qwen-code/qwen-code-core';

vi.mock('../../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string>) => {
    if (params) {
      return Object.entries(params).reduce(
        (str, [paramKey, value]) => str.replace(`{{${paramKey}}}`, value),
        key,
      );
    }
    return key;
  },
}));

describe('skillsCommand', () => {
  let mockContext: CommandContext;
  let listSkills: ReturnType<typeof vi.fn>;
  const reviewSkill: SkillConfig = {
    name: 'review',
    description: 'Review code changes',
    level: 'project',
    filePath: '/test/project/.qwen/skills/review/SKILL.md',
    body: '# review',
  };
  const testSkill: SkillConfig = {
    name: 'test',
    description: 'Generate tests',
    level: 'user',
    filePath: '/test/home/.qwen/skills/test/SKILL.md',
    body: '# test',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    listSkills = vi.fn().mockResolvedValue([testSkill, reviewSkill]);

    mockContext = createMockCommandContext({
      services: {
        config: {
          getSkillManager: vi.fn().mockReturnValue({
            listSkills,
          }),
        },
      },
    });
  });

  it('returns a text list in ACP mode', async () => {
    mockContext.executionMode = 'acp';

    const result = await skillsCommand.action!(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Available skills:\n- review\n- test',
    });
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('returns an error message in ACP mode when skill name is unknown', async () => {
    mockContext.executionMode = 'acp';

    const result = await skillsCommand.action!(mockContext, 'unknown');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Unknown skill: unknown',
    });
    expect(mockContext.ui.addItem).not.toHaveBeenCalled();
  });

  it('returns submit_prompt in ACP mode when skill name exists', async () => {
    mockContext.executionMode = 'acp';
    mockContext.invocation = {
      raw: '/skills review',
      name: 'skills',
      args: 'review',
    };

    const result = await skillsCommand.action!(mockContext, 'review');

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: '/skills review' }],
    });
  });

  it('adds a skills list item in interactive mode', async () => {
    mockContext.executionMode = 'interactive';

    const result = await skillsCommand.action!(mockContext, '');

    expect(result).toBeUndefined();
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.SKILLS_LIST,
        skills: [{ name: 'review' }, { name: 'test' }],
      },
      expect.any(Number),
    );
  });
});
