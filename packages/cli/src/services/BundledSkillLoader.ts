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
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';

const debugLogger = createDebugLogger('BUNDLED_SKILL_LOADER');

/**
 * Loads bundled skills as slash commands, making them directly invocable
 * via /<skill-name> (e.g., /review).
 */
export class BundledSkillLoader implements ICommandLoader {
  constructor(private readonly config: Config | null) {}

  async loadCommands(_signal: AbortSignal): Promise<SlashCommand[]> {
    const skillManager = this.config?.getSkillManager();
    if (!skillManager) {
      debugLogger.debug('SkillManager not available, skipping bundled skills');
      return [];
    }

    try {
      const allSkills = await skillManager.listSkills({ level: 'bundled' });

      // Hide skills whose allowedTools require cron when cron is disabled
      const cronEnabled = this.config?.isCronEnabled() ?? false;
      const skills = allSkills.filter((skill) => {
        if (
          !cronEnabled &&
          skill.allowedTools?.some((t) => t.startsWith('cron_'))
        ) {
          debugLogger.debug(
            `Hiding skill "${skill.name}" because cron is not enabled`,
          );
          return false;
        }
        return true;
      });

      debugLogger.debug(
        `Loaded ${skills.length} bundled skill(s) as slash commands`,
      );

      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        kind: CommandKind.SKILL,
        action: async (context, _args): Promise<SlashCommandActionReturn> => {
          const content = context.invocation?.args
            ? appendToLastTextPart(
                [{ text: skill.body }],
                context.invocation.raw,
              )
            : [{ text: skill.body }];

          return {
            type: 'submit_prompt',
            content,
          };
        },
      }));
    } catch (error) {
      debugLogger.error('Failed to load bundled skills:', error);
      return [];
    }
  }
}
