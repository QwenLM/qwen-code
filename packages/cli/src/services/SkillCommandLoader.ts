/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  createDebugLogger,
  appendToLastTextPart,
} from '@qwen-code/qwen-code-core';
import type { ICommandLoader } from './types.js';
import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandSource,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';

const debugLogger = createDebugLogger('SKILL_COMMAND_LOADER');

/**
 * Loads user-level, project-level, and extension-level skills as slash
 * commands, making them directly invocable via /<skill-name>.
 *
 * - User/project skills: always model-invocable (same as bundled), unless
 *   disable-model-invocation is set.
 * - Extension skills: model-invocable only when description or whenToUse is
 *   present (same rule as plugin commands), unless disable-model-invocation
 *   is set.
 */
export class SkillCommandLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    if (this.config?.getBareMode?.()) {
      debugLogger.debug('Bare mode enabled, skipping skill commands');
      return [];
    }

    const skillManager = this.config?.getSkillManager();
    if (!skillManager) {
      debugLogger.debug('SkillManager not available, skipping skill commands');
      return [];
    }

    try {
      const [userSkills, projectSkills, extensionSkills] = await Promise.all([
        skillManager.listSkills({ level: 'user' }),
        skillManager.listSkills({ level: 'project' }),
        skillManager.listSkills({ level: 'extension' }),
      ]);

      const allSkills = [...userSkills, ...projectSkills, ...extensionSkills];

      debugLogger.debug(
        `Loaded ${userSkills.length} user + ${projectSkills.length} project + ${extensionSkills.length} extension skill(s) as slash commands`,
      );

      return allSkills.map((skill) => {
        const isExtension = skill.level === 'extension';

        // Extension skills need explicit description or whenToUse to be
        // model-invocable (same rule as plugin commands).
        // User/project skills are always model-invocable.
        const modelInvocable = skill.disableModelInvocation
          ? false
          : isExtension
            ? !!(skill.description || skill.whenToUse)
            : true;

        const sourceLabel = isExtension
          ? `Extension: ${skill.extensionName ?? 'unknown'}`
          : skill.level === 'project'
            ? 'Project'
            : 'User';

        return {
          name: skill.name,
          description: skill.description,
          kind: CommandKind.SKILL,
          source: (isExtension
            ? 'plugin-command'
            : 'skill-dir-command') as CommandSource,
          sourceLabel,
          modelInvocable,
          whenToUse: skill.whenToUse,
          action: async (context, _args): Promise<SlashCommandActionReturn> => {
            const body = skill.body;

            const content = context.invocation?.args
              ? appendToLastTextPart([{ text: body }], context.invocation.raw)
              : [{ text: body }];

            return {
              type: 'submit_prompt',
              content,
            };
          },
        };
      });
    } catch (error) {
      debugLogger.error('Failed to load skill commands:', error);
      return [];
    }
  }
}
