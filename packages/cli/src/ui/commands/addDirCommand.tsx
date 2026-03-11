/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { directoryCommand } from './directoryCommand.js';
import { t } from '../../i18n/index.js';

/**
 * `/add-dir` — a convenience alias that delegates to `/directory add`.
 *
 * Usage: `/add-dir /path/to/dir` (equivalent to `/directory add /path/to/dir`)
 */
export const addDirCommand: SlashCommand = {
  name: 'add-dir',
  altNames: [],
  get description() {
    return t('Add directories to the workspace (alias for /directory add)');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext, args: string) => {
    // Delegate to the `add` subcommand of `/directory`
    const addSubCommand = directoryCommand.subCommands?.find(
      (sub) => sub.name === 'add',
    );
    if (!addSubCommand?.action) {
      return;
    }
    return addSubCommand.action(context, args);
  },
};
