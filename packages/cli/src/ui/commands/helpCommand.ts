/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const helpCommand: SlashCommand = {
  name: 'help',
  altNames: ['?'],
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  get description() {
    return t('for help on Qwen Code');
  },
  action: async () => ({
    type: 'dialog',
    dialog: 'help',
  }),
};
