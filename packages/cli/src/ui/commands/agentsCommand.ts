/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type SlashCommand,
  type OpenDialogActionReturn,
} from './types.js';
import { t } from '../../i18n/index.js';

export const agentsCommand: SlashCommand = {
  name: 'agents',
  get description() {
    return t('Manage subagents for specialized task delegation.');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'manage',
      get description() {
        return t('Manage existing subagents (view, edit, delete).');
      },
      kind: CommandKind.BUILT_IN,
      action: (): OpenDialogActionReturn => ({
        type: 'dialog',
        dialog: 'subagent_list',
      }),
    },
    {
      name: 'create',
      get description() {
        return t('Create a new subagent with guided setup.');
      },
      kind: CommandKind.BUILT_IN,
      action: (): OpenDialogActionReturn => ({
        type: 'dialog',
        dialog: 'subagent_create',
      }),
    },
  ],
};
