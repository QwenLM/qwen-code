/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, SlashCommand, OpenDialogActionReturn } from './types.js';

export const agentsCommand: SlashCommand = {
  name: 'agents',
  description: 'Manage subagents for specialized task delegation.',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'list',
      description: 'Manage existing subagents (view, edit, delete).',
      kind: CommandKind.BUILT_IN,
      action: (): OpenDialogActionReturn => ({
        type: 'dialog',
        dialog: 'subagent_list',
      }),
    },
    {
      name: 'create',
      description: 'Create a new subagent with guided setup.',
      kind: CommandKind.BUILT_IN,
      action: (): OpenDialogActionReturn => ({
        type: 'dialog',
        dialog: 'subagent_create',
      }),
    },
  ],
};
