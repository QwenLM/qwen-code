/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const rewindCommand: SlashCommand = {
  name: 'rewind',
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Browse prompts in the current conversation and fork from one');
  },
  action: async (): Promise<SlashCommandActionReturn> => ({
    type: 'dialog',
    dialog: 'rewind',
  }),
};
