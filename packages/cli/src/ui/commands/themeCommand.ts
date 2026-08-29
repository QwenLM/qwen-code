/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import type {
  MessageActionReturn,
  OpenDialogActionReturn,
  SlashCommand,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const themeCommand: SlashCommand = {
  name: 'theme',
  get description() {
    return t('change the theme');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  canRunDuringStreaming: true,
  action: (_context, _args): OpenDialogActionReturn | MessageActionReturn => {
    // Reject before opening the dialog: with NO_COLOR the theme picker
    // cannot run, and returning a message lets the processor record the
    // feedback after the invocation record instead of before it.
    if (process.env['NO_COLOR']) {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Theme configuration unavailable due to NO_COLOR env variable.',
        ),
      };
    }
    return {
      type: 'dialog',
      dialog: 'theme',
    };
  },
};
