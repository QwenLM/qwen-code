/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createElement } from 'react';
import { CommandKind, type SlashCommand } from './types.js';
import { MessageType } from '../types.js';
import { CrontabDialog } from '../components/crontab/CrontabDialog.js';

export const crontabCommand: SlashCommand = {
  name: 'crontab',
  description: 'Manage scheduled loops and cron jobs',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  action: async (context) => ({
    type: 'custom_dialog' as const,
    component: createElement(CrontabDialog, {
      onExit: (result) => {
        context.ui.removeComponent();
        if (result) {
          context.ui.addItem(
            {
              type: MessageType.INFO,
              text: result,
            },
            Date.now(),
          );
        }
      },
    }),
  }),
};
