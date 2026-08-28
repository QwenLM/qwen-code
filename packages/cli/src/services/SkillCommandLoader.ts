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
  recordAutoSkillUsage,
} from '@qwen-code/qwen-code-core';
import { skillMatchesSettingName } from '../config/skill-settings.js';
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

export type SkillCommandLevel = 'user' | 'project' | 'extension';

const ALL_SKILL_LEVELS: readonly SkillCommandLevel[] = [
  'user',
  'project',
  'extension',
];

/**
 * Loads skills from the given levels as slash commands, making them directly
 * invocable via /<skill-name>. Defaults to every level; production passes an
 * explicit level set so that extension skills can be aggregated after
 * `FileCommandLoader` while user and project skills keep their historic
 * position. Only extension skills carry an `extensionName`, and only
 * extension skills reach the collision rename in `CommandService`, so the two
 * groups cannot share one aggregation slot without deciding, by array order
 * alone, which of them silently overwrites a same-named file command.
 *
 * - User/project skills: always model-invocable (same as bundled), unless
 *   disable-model-invocation is set.
 * - Extension skills: model-invocable only when description or whenToUse is
 *   present (same rule as plugin commands), unless disable-model-invocation
 *   is set.
 */
export class SkillCommandLoader implements ICommandLoader {
  constructor(
    private readonly config: Config | null,
    readonly levels: readonly SkillCommandLevel[] = ALL_SKILL_LEVELS,
  ) {}

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
      const loadedPerLevel = await Promise.all(
        this.levels.map((level) => skillManager.listSkills({ level })),
      );

      const allSkills = loadedPerLevel.flat();

      // Apply user-controlled `skills.disabled` filter HERE (inside the
      // skill loader) rather than via `CommandService`'s global denylist —
      // a global filter would also hide a same-named built-in command or
      // MCP prompt. See `Config.getDisabledSkillNames` for why this is a
      // live-read provider rather than a frozen field.
      const disabled =
        this.config?.getDisabledSkillNames() ?? new Set<string>();
      const visibleSkills = allSkills.filter(
        (skill) => !skillMatchesSettingName(skill, disabled),
      );
      const nonUserInvocableCount = visibleSkills.filter(
        (skill) => skill.userInvocable === false,
      ).length;

      const perLevel = this.levels
        .map((level, i) => `${loadedPerLevel[i]?.length ?? 0} ${level}`)
        .join(' + ');

      debugLogger.debug(
        `Loaded ${perLevel} skill(s) as slash commands; ${allSkills.length - visibleSkills.length} hidden by skills.disabled; ${nonUserInvocableCount} marked non-user-invocable`,
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
          ? `${t('Extension:')} ${skill.extensionDisplayName ?? skill.extensionName ?? 'unknown'}`
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
          // Marks this as an extension command so CommandService can
          // disambiguate duplicate names instead of overwriting them.
          ...(isExtension && skill.extensionName
            ? { extensionName: skill.extensionName }
            : {}),
          skillDetail: {
            name: skill.name,
            description: skill.description,
            body: skill.body,
            filePath: skill.filePath,
            level: skill.level,
            ...(isExtension && skill.extensionName
              ? { extensionName: skill.extensionName }
              : {}),
          },
          action: async (context, _args): Promise<SlashCommandActionReturn> => {
            // Auto-approve the skill's declared allowedTools before its body is submitted.
            applySkillAllowedTools(
              this.config?.getPermissionManager(),
              skill.allowedTools,
            );

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
