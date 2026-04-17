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
  action: async (context) => {
    const executionMode = context.executionMode ?? 'interactive';

    if (executionMode === 'interactive') {
      return {
        type: 'dialog',
        dialog: 'memory',
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t(
        'The memory manager is only available in the interactive UI. In non-interactive mode, open the user or project memory files directly.',
      ),
    };
  },
};
