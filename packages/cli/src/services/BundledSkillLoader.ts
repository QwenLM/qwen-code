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
      const skills = await skillManager.listSkills({ level: 'bundled' });
      debugLogger.debug(
        `Loaded ${skills.length} bundled skill(s) as slash commands`,
      );

      return skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        kind: CommandKind.SKILL,
        action: async (context, _args): Promise<SlashCommandActionReturn> => {
          // listSkills({ level: 'bundled' }) returns only the bundled version.
          // loadSkill() re-discovers via precedence (project > user > extension > bundled),
          // so a project-level skill with `extends: bundled` gets resolved here.
          let resolvedSkill = skill;
          try {
            resolvedSkill = (await skillManager.loadSkill(skill.name)) ?? skill;
          } catch (error) {
            debugLogger.warn(
              `Failed to resolve skill "${skill.name}", using bundled version:`,
              error,
            );
          }

          const content = context.invocation?.args
            ? appendToLastTextPart(
                [{ text: resolvedSkill.body }],
                context.invocation.raw,
              )
            : [{ text: resolvedSkill.body }];

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
