/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@qwen-code/resource';
import type { Config } from '../config/config.js';
import { activateSelectedSkills } from './selectedSkillActivation.js';

function skill(
  name: string,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    location: `/workspace/.qwen/skills/${name}/SKILL.md`,
    skillRoot: `/workspace/.qwen/skills/${name}`,
    body: `${name} body: $ARGUMENTS`,
    ...overrides,
  } as SkillDefinition;
}

function setup(skills: SkillDefinition[]) {
  const activateSkill = vi.fn();
  const recordUsage = vi.fn(async () => {});
  const skillMap = new Map(skills.map((value) => [value.name.toLowerCase(), value]));
  const config = {
    isSkillsSupportEnabled: () => true,
    isWorkflowsEnabled: () => false,
    isSkillShellExecutionDisabled: () => false,
    getSessionId: () => 'session-1',
    getModel: () => 'test-model',
    getToolRegistry: () => ({ getFunctionDeclarations: () => [] }),
    getSkillManager: () => ({
      isAdminEnabled: () => true,
      getSkill: (name: string) => skillMap.get(name.toLowerCase()) ?? null,
      activateSkill,
      recordUsage,
    }),
  } as unknown as Config;
  return { config, activateSkill, recordUsage };
}

describe('activateSelectedSkills', () => {
  it('activates multiple user-selected skills in order and bypasses only the model gate', async () => {
    const first = skill('review', {
      disableModelInvocation: true,
      allowedTools: ['Read', 'Grep'],
    });
    const second = skill('explain', {
      allowedTools: ['Grep', 'Write'],
    });
    const { config, activateSkill } = setup([first, second]);

    const result = await activateSelectedSkills(config, [
      { name: 'review', arguments: '--strict' },
      { name: 'explain' },
    ]);

    expect(result.allowedTools).toEqual(['Read', 'Grep', 'Write']);
    expect(result.skillActivations).toEqual([
      expect.objectContaining({
        skillName: 'review',
        activationSource: 'selected_skills',
      }),
      expect.objectContaining({
        skillName: 'explain',
        activationSource: 'selected_skills',
      }),
    ]);
    expect(result.messages).toHaveLength(4);
    expect(result.messages[0]?.type).toBe('user');
    expect(JSON.stringify(result.messages[0])).toContain('/review');
    expect(result.messages[0]?.isMeta).not.toBe(true);
    expect(JSON.stringify(result.messages[0])).not.toContain(
      'review body: --strict',
    );
    expect(JSON.stringify(result.messages[1])).toContain('review body: --strict');
    expect(result.messages[1]?.isMeta).toBe(true);
    expect(JSON.stringify(result.messages[2])).toContain('/explain');
    expect(result.messages[2]?.isMeta).not.toBe(true);
    expect(JSON.stringify(result.messages[3])).toContain('explain body:');
    expect(result.messages[3]?.isMeta).toBe(true);
    expect(activateSkill).toHaveBeenNthCalledWith(
      1,
      'review',
      expect.stringContaining('review body: --strict'),
    );
    expect(activateSkill).toHaveBeenNthCalledWith(
      2,
      'explain',
      expect.stringContaining('explain body:'),
    );
  });

  it('validates every selection before activating any skill', async () => {
    const { config, activateSkill } = setup([skill('review')]);

    await expect(
      activateSelectedSkills(config, [
        { name: 'review' },
        { name: 'missing' },
      ]),
    ).rejects.toThrow('Selected skill "missing" is unavailable.');
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it('activates in order and does not start later bodies after a failure', async () => {
    const preparationOrder: string[] = [];
    const firstBody = vi.fn(async () => {
      preparationOrder.push('first');
      throw new Error('first body failed');
    });
    const secondBody = vi.fn(async () => {
      preparationOrder.push('second');
      return 'second body';
    });
    const { config, activateSkill } = setup([
      skill('first', { getBody: firstBody }),
      skill('second', { getBody: secondBody }),
    ]);

    await expect(
      activateSelectedSkills(config, [
        { name: 'first' },
        { name: 'second' },
      ]),
    ).rejects.toThrow('first body failed');

    expect(preparationOrder).toEqual(['first']);
    expect(secondBody).not.toHaveBeenCalled();
    expect(activateSkill).not.toHaveBeenCalled();
  });

  it('reports a later failure and continues activating remaining Skills', async () => {
    const secondBody = vi.fn(async () => {
      throw new Error('second body failed');
    });
    const { config, activateSkill } = setup([
      skill('first', { allowedTools: ['Read'], model: 'model-a' }),
      skill('second', {
        allowedTools: ['Write'],
        getBody: secondBody,
        model: 'failed-model',
      }),
      skill('third', {
        allowedTools: ['Grep'],
        effort: 'high',
        model: 'model-c',
      }),
    ]);

    const result = await activateSelectedSkills(config, [
      { name: 'first' },
      { name: 'second' },
      { name: 'third' },
    ]);

    expect(activateSkill).toHaveBeenCalledTimes(2);
    expect(activateSkill).toHaveBeenNthCalledWith(
      1,
      'first',
      expect.stringContaining('first body:'),
    );
    expect(activateSkill).toHaveBeenNthCalledWith(
      2,
      'third',
      expect.stringContaining('third body:'),
    );
    expect(result.messages).toHaveLength(5);
    expect(result.messages[2]).toMatchObject({
      type: 'system',
      subtype: 'informational',
      level: 'error',
    });
    expect(JSON.stringify(result.messages[2])).toContain(
      'Stacked skill /second failed to load: second body failed',
    );
    expect(result.allowedTools).toEqual(['Read', 'Grep']);
    expect(result.model).toBe('model-c');
    expect(result.effort).toBe('high');
    expect(result.skillActivations.map(({ skillName }) => skillName)).toEqual([
      'first',
      'third',
    ]);
  });

  it('uses the last successful Skill model and effort overrides', async () => {
    const { config, activateSkill } = setup([
      skill('review', { effort: 'low', model: 'model-a' }),
      skill('explain', { effort: 'high', model: 'model-b' }),
    ]);

    const result = await activateSelectedSkills(config, [
      { name: 'review' },
      { name: 'explain' },
    ]);

    expect(result.model).toBe('model-b');
    expect(result.effort).toBe('high');
    expect(activateSkill).toHaveBeenCalledTimes(2);
  });

  it('rejects duplicate and fork-scoped selections', async () => {
    const { config } = setup([skill('review'), skill('forked', { context: 'fork' })]);

    await expect(
      activateSelectedSkills(config, [
        { name: 'review' },
        { name: 'REVIEW' },
      ]),
    ).rejects.toThrow('appears more than once');
    await expect(
      activateSelectedSkills(config, [{ name: 'forked' }]),
    ).rejects.toThrow('Invoke it as a slash command instead.');
  });
});
