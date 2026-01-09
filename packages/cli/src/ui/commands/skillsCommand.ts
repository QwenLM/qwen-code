/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandCompletionItem,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import { MessageType, type HistoryItemSkillsList } from '../types.js';
import { t } from '../../i18n/index.js';
import { AsyncFzf } from 'fzf';
import type { SkillConfig } from '@qwen-code/qwen-code-core';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  get description() {
    return t('List available skills.');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args?: string) => {
    const rawArgs = args?.trim() ?? '';
    const [skillName = ''] = rawArgs.split(/\s+/);

    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Could not retrieve skill manager.'),
        },
        Date.now(),
      );
      return;
    }

    const skills = await skillManager.listSkills();
    if (skills.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('No skills are currently available.'),
        },
        Date.now(),
      );
      return;
    }

    if (!skillName) {
      const sortedSkills = [...skills].sort((left, right) =>
        left.name.localeCompare(right.name),
      );
      const skillsListItem: HistoryItemSkillsList = {
        type: MessageType.SKILLS_LIST,
        skills: sortedSkills.map((skill) => ({ name: skill.name })),
      };
      context.ui.addItem(skillsListItem, Date.now());
      return;
    }
    const normalizedName = skillName.toLowerCase();
    const hasSkill = skills.some(
      (skill) => skill.name.toLowerCase() === normalizedName,
    );

    if (!hasSkill) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Unknown skill: {{name}}', { name: skillName }),
        },
        Date.now(),
      );
      return;
    }

    const rawInput = context.invocation?.raw ?? `/skills ${rawArgs}`;
    return {
      type: 'submit_prompt',
      content: [{ text: rawInput }],
    };
  },
  completion: async (
    context: CommandContext,
    partialArg: string,
  ): Promise<CommandCompletionItem[]> => {
    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) {
      return [];
    }

    const skills = await skillManager.listSkills();
    const normalizedPartial = partialArg.trim();
    const matches = await getSkillMatches(skills, normalizedPartial);

    return matches.map((skill) => ({
      value: skill.name,
      description: skill.description,
    }));
  },
};

async function getSkillMatches(
  skills: SkillConfig[],
  query: string,
): Promise<SkillConfig[]> {
  if (!query) {
    return skills;
  }

  const names = skills.map((skill) => skill.name);
  const skillMap = new Map(skills.map((skill) => [skill.name, skill]));

  try {
    const fzf = new AsyncFzf(names, {
      fuzzy: 'v2',
      casing: 'case-insensitive',
    });
    const results = (await fzf.find(query)) as Array<{ item: string }>;
    return results
      .map((result) => skillMap.get(result.item))
      .filter((skill): skill is SkillConfig => !!skill);
  } catch (error) {
    console.error('[skillsCommand] Fuzzy match failed:', error);
    const lowerQuery = query.toLowerCase();
    return skills.filter((skill) =>
      skill.name.toLowerCase().startsWith(lowerQuery),
    );
  }
}
