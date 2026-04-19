/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const rewindCommand: SlashCommand = {
  name: 'rewind',
  altNames: ['rollback'],
  get description() {
    return t('Rewind conversation to a previous turn');
  },
  kind: CommandKind.BUILT_IN,
  action: async (): Promise<SlashCommandActionReturn> => ({
      type: 'dialog',
      dialog: 'rewind',
    }),
};
