/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType, type HistoryItemSkillsList } from '../types.js';
import { t } from '../../i18n/index.js';
import { normalizeSkillPriority } from '@qwen-code/qwen-code-core';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  get description() {
    return t('Open the skills panel (browse, search, toggle, pick).');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  // Accepting `/skills` from the auto-completion popup (e.g. typing
  // `/skil<Enter>`) submits immediately rather than inserting `/skills `
  // and forcing a second Enter — `/skills` has no required arg, the bare
  // action just opens the dialog. See `SlashCommand.submitOnAccept`.
  submitOnAccept: true,
  action: async (
    context: CommandContext,
  ): Promise<void | SlashCommandActionReturn> => {
    // `/skills` is dialog-only. Any trailing args are ignored — the dialog
    // is the single entry for browsing, search, toggle, and skill launch.
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

    if (context.executionMode === 'interactive') {
      return { type: 'dialog', dialog: 'skills_manage' };
    }

    // ACP / non-interactive: dialog can't render; fall back to a read-only
    // listing so users in those contexts still get something useful from
    // the bare command.
    const skills = await skillManager.listSkills();
    // Reuse the central disabled-set provider so all surfaces
    // (<available_skills>, /<name> completion, this list) agree on a
    // single normalization pass instead of drifting independently.
    const disabled =
      context.services.config?.getDisabledSkillNames() ?? new Set<string>();
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
  },
};
