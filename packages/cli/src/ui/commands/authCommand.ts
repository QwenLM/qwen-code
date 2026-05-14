/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  OpenDialogActionReturn,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const authCommand: SlashCommand = {
  name: 'auth',
  altNames: ['login'],
  get description() {
    return t('Configure authentication information for login');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'],
  action: (
    context,
    _args,
  ): OpenDialogActionReturn | SlashCommandActionReturn => {
    const executionMode = context.executionMode ?? 'interactive';
    if (executionMode !== 'interactive') {
      return {
        type: 'message',
        messageType: 'info',
        content: t(
          'Authentication configuration is only available in interactive mode. To configure authentication, run Qwen Code interactively and use /auth, or set environment variables: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL.',
        ),
      };
    }
    return {
      type: 'dialog',
      dialog: 'auth',
    };
  },
};
