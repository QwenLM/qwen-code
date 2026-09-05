/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import {
  createDebugLogger,
  appendToLastTextPart,
  buildSkillLlmContent,
  applySkillAllowedTools,
  canApplySkillSideEffects,
  recordAutoSkillUsage,
} from '@qwen-code/qwen-code-core';
import { dirname } from 'node:path';
import type { ICommandLoader } from './types.js';
import {
  writeSkillArgs,
  clearSkillArgs,
  staleArgsWarning,
  skillArgsNote,
  skillArgsPath,
} from './skill-args-file.js';
import type {
  SlashCommand,
  SlashCommandActionReturn,
  CommandSource,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import { t } from '../i18n/index.js';
import { extensionOwnerLabel } from './commandMetadata.js';

const debugLogger = createDebugLogger('SKILL_COMMAND_LOADER');

export async function recordAutoSkillCommandUsage(
  config: Config | null,
  command: SlashCommand,
): Promise<void> {
  const detail = command.skillDetail;
  if (!config || detail?.level !== 'project' || !detail.filePath) {
    return;
  }
  try {
    await recordAutoSkillUsage(config.getProjectRoot(), {
      name: detail.name,
      level: 'project',
      filePath: detail.filePath,
    });
  } catch (error) {
    debugLogger.warn(
      `Failed to record auto-skill command usage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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

      // Filter by source here; a global denylist would also hide unrelated
      // commands or skills with the same name.
      const visibleSkills = allSkills.filter(
        (skill) => this.config?.isSkillEnabled(skill) ?? true,
      );
      const nonUserInvocableCount = visibleSkills.filter(
        (skill) => skill.userInvocable === false,
      ).length;

      debugLogger.debug(
        `Loaded ${userSkills.length} user + ${projectSkills.length} project + ${extensionSkills.length} extension skill(s) as slash commands; ${allSkills.length - visibleSkills.length} disabled; ${nonUserInvocableCount} marked non-user-invocable`,
      );

      return visibleSkills.map((skill) => {
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
          ? extensionOwnerLabel({
              name: skill.extensionName,
              displayName: skill.extensionDisplayName,
            })
          : skill.level === 'project'
            ? t('Project')
            : t('User');

        return {
          name: skill.name,
          description: skill.description,
          modelDescription: skill.description,
          kind: CommandKind.SKILL,
          source: (isExtension
            ? 'plugin-command'
            : 'skill-dir-command') as CommandSource,
          sourceLabel,
          sourceDetail: isExtension
            ? 'extension'
            : skill.level === 'project'
              ? 'project'
              : 'user',
          userInvocable: skill.userInvocable ?? true,
          modelInvocable,
          argumentHint: skill.argumentHint,
          whenToUse: skill.whenToUse,
          skillDetail: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            filePath: skill.filePath,
            level: skill.level,
            ...(isExtension && skill.extensionName
              ? {
                  extensionName: skill.extensionName,
                  authoredName: skill.authoredName,
                }
              : {}),
          },
          action: async (context, _args): Promise<SlashCommandActionReturn> => {
            if (this.config && !this.config.isSkillEnabled(skill)) {
              return {
                type: 'message',
                messageType: 'error',
                content: `Skill "${skill.name}" is disabled.`,
              };
            }
            // Auto-approve the skill's declared allowedTools before its body is submitted.
            if (this.config && canApplySkillSideEffects(skill, this.config)) {
              applySkillAllowedTools(
                this.config.getPermissionManager(),
                skill.allowedTools,
                { trustGated: skill.level === 'project' },
              );
            } else if (skill.allowedTools?.length) {
              debugLogger.warn(
                `Skill "${skill.name}" is a project skill in an untrusted folder; ignoring its allowedTools.`,
              );
            }

            const body = buildSkillLlmContent(
              dirname(skill.filePath),
              skill.body,
            );

            // See BundledSkillLoader: the arguments are written down for the
            // skill to read, rather than transcribed by the model, and a bare
            // invocation erases any prior record so its authority is not reused.
            const rawArgs = context.invocation?.args ?? '';
            let content;
            if (rawArgs) {
              content = appendToLastTextPart(
                [{ text: body }],
                context.invocation!.raw +
                  (writeSkillArgs(skill.name, rawArgs)
                    ? skillArgsNote(skillArgsPath(skill.name), rawArgs)
                    : ''),
              );
            } else {
              // See BundledSkillLoader: a failed revocation leaves the earlier
              // run's posting authority on disk, and the skill must be told.
              content = [{ text: body }];
              if (!clearSkillArgs(skill.name)) {
                content = appendToLastTextPart(content, staleArgsWarning());
              }
            }

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
