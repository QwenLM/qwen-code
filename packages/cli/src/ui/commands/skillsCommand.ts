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
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType, type HistoryItemSkillsList } from '../types.js';
import { t } from '../../i18n/index.js';
import { AsyncFzf } from 'fzf';
import type { SkillConfig } from '@qwen-code/qwen-code-core';
import {
  createDebugLogger,
  normalizeSkillPriority,
} from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('SKILLS_COMMAND');

function getDisabledSet(context: CommandContext): ReadonlySet<string> {
  const list = context.services.settings?.merged.skills?.disabled ?? [];
  return new Set(list.map((n) => n.trim().toLowerCase()).filter(Boolean));
}

export const skillsCommand: SlashCommand = {
  name: 'skills',
  get description() {
    return t('Manage skills (open enable/disable dialog).');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (
    context: CommandContext,
    args?: string,
  ): Promise<void | SlashCommandActionReturn> => {
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

    // Bare `/skills` opens the manage dialog — single entry, search and
    // toggle live there. In ACP / non-interactive mode the dialog can't
    // render, so we fall back to a read-only listing for those contexts.
    if (!skillName) {
      if (context.executionMode === 'interactive') {
        return { type: 'dialog', dialog: 'skills_manage' };
      }
      const skills = await skillManager.listSkills();
      const disabled = getDisabledSet(context);
      const visibleSkills = skills.filter(
        (s) => !disabled.has(s.name.toLowerCase()),
      );
      if (visibleSkills.length === 0) {
        context.ui.addItem(
          {
            type: MessageType.INFO,
            text:
              skills.length === 0
                ? t('No skills are currently available.')
                : t(
                    'All available skills are disabled. Edit ~/.qwen/settings.json or .qwen/settings.json (skills.disabled) to re-enable.',
                  ),
          },
          Date.now(),
        );
        return;
      }
      const sortedSkills = [...visibleSkills].sort(
        (a, b) =>
          normalizeSkillPriority(b.priority) -
            normalizeSkillPriority(a.priority) || a.name.localeCompare(b.name),
      );
      const skillsListItem: HistoryItemSkillsList = {
        type: MessageType.SKILLS_LIST,
        skills: sortedSkills.map((skill) => ({ name: skill.name })),
      };
      context.ui.addItem(skillsListItem, Date.now());
      return;
    }

    // `/skills <name>` invocation path — pre-existing power-user shortcut
    // that re-submits the raw input as a prompt. Works in any mode and is
    // unrelated to the enable/disable management surface (which is now
    // dialog-only). Kept because skills with disable-model-invocation
    // can still be triggered this way.
    const skills = await skillManager.listSkills();
    const disabled = getDisabledSet(context);
    const normalizedName = skillName.toLowerCase();
    const matched = skills.find(
      (skill) => skill.name.toLowerCase() === normalizedName,
    );

    if (!matched) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Unknown skill: {{name}}', { name: skillName }),
        },
        Date.now(),
      );
      return;
    }

    if (disabled.has(normalizedName)) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Skill "{{name}}" is disabled. Re-enable it via /skills or remove it from skills.disabled.',
            { name: matched.name },
          ),
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
    if (!skillManager) return [];

    // Only suggest skill names (for `/skills <name>` invocation). The
    // dialog handles enable/disable interactively, so there are no
    // subcommands to surface in the auto-completion popup.
    const skills = await skillManager.listSkills();
    const disabled = getDisabledSet(context);
    const visible = skills.filter((s) => !disabled.has(s.name.toLowerCase()));
    return matchSkillCandidates(visible, partialArg);
  },
};

async function matchSkillCandidates(
  skills: SkillConfig[],
  query: string,
): Promise<CommandCompletionItem[]> {
  const matched = await getSkillMatches(skills, query);
  return matched.map((skill) => ({
    value: skill.name,
    description: skill.description,
  }));
}

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
    debugLogger.error('[skillsCommand] Fuzzy match failed:', error);
    const lowerQuery = query.toLowerCase();
    return skills.filter((skill) =>
      skill.name.toLowerCase().startsWith(lowerQuery),
    );
  }
}
