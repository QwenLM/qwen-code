/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const memoryCommand: SlashCommand = {
  name: 'memory',
  get description() {
    return t('Open the memory manager.');
  },
  kind: CommandKind.BUILT_IN,
  commandType: 'local-jsx',
  action: async () => ({
    type: 'dialog',
    dialog: 'memory',
  }),
};
