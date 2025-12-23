/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  OpenDialogActionReturn,
} from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import { t } from '../i18n/index.js';

export const skillsCommand: SlashCommand = {
  name: 'skill',
  get description() {
    return t('Manage and inspect skills.');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'manage',
      get description() {
        return t('Manage existing skills (view, edit, delete).');
      },
      kind: CommandKind.BUILT_IN,
      action: (): OpenDialogActionReturn => ({
        type: 'dialog',
        dialog: 'skill_list',
      }),
    },
    {
      name: 'create',
      get description() {
        return t('Create a new skill with guided setup.');
      },
      kind: CommandKind.BUILT_IN,
      action: (): OpenDialogActionReturn => ({
        type: 'dialog',
        dialog: 'skill_create',
      }),
    },
  ],
};
