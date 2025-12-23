/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillTool } from './skill.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { Skill } from '../skills/types.js';

vi.mock('../core/prompts.js', () => ({
  getSkillProtocolReminder: vi.fn().mockReturnValue('<protocol/>'),
}));

describe('SkillTool', () => {
  let skillManager: SkillManager;
  let config: Config;
  let tool: SkillTool;

  beforeEach(() => {
    skillManager = {
      listSkills: vi.fn(),
      loadSkill: vi.fn(),
      generateProtocolReminder: vi.fn(),
      getSkillFileTree: vi.fn(),
      addChangeListener: vi.fn(),
    } as unknown as SkillManager;

    config = {
      getSkillManager: () => skillManager,
      getGeminiClient: vi.fn(),
    } as unknown as Config;
    tool = new SkillTool(config);
  });

  it('correctly initializes with available skills', async () => {
    const skills: Skill[] = [
      {
        path: '/fake/path/a',
        metadata: { name: 'skill-a', description: 'Skill A' },
        instructions: 'Do A',
      },
      {
        path: '/fake/path/b',
        metadata: { name: 'skill-b', description: 'Skill B' },
        instructions: 'Do B',
      },
    ];
    vi.spyOn(skillManager, 'listSkills').mockResolvedValue(skills);

    const localTool = new SkillTool(config);
    await localTool.refreshSkills();

    expect(localTool.name).toBe('skill');
    expect(localTool.description).toContain('<available_skills>');
    expect(localTool.description).toContain('skill-a: Skill A');
    expect(localTool.description).toContain('skill-b: Skill B');
  });

  it('returns an error if skill name is not a string', () => {
    // @ts-expect-error We are intentionally passing an invalid type.
    expect(() => tool.build({ skill: 123 })).toThrow(
      'params/skill must be string',
    );
  });

  it('returns an error if skill is not found', async () => {
    vi.spyOn(skillManager, 'loadSkill').mockResolvedValue(undefined);

    const invocation = tool.build({ skill: 'non-existent' });
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      undefined,
    );

    expect(result.llmContent).toBe('Error: Skill "non-existent" not found.');
    expect(result.returnDisplay).toBe('Error: Skill not found.');
  });

  it('returns skill details on successful invocation', async () => {
    const skill: Skill = {
      path: '/fake/path/a',
      metadata: { name: 'skill-a', description: 'Skill A' },
      instructions: 'Do A',
    };
    vi.spyOn(skillManager, 'loadSkill').mockResolvedValue(skill);
    vi.spyOn(skillManager, 'getSkillFileTree').mockResolvedValue(
      '<file_tree/>',
    );

    const invocation = tool.build({ skill: 'skill-a' });
    const result = await invocation.execute(
      new AbortController().signal,
      undefined,
      undefined,
    );

    expect(result.returnDisplay).toBe('Skill A');
    expect(result.llmContent).toContain('<name>skill-a</name>');
    expect(result.llmContent).toContain('<path>/fake/path/a</path>');
    expect(result.llmContent).toContain('<instructions>');
    expect(result.llmContent).toContain('Do A');
    expect(result.llmContent).toContain('<file_tree/>');
    expect(result.llmContent).toContain('<protocol/>');
  });
});
