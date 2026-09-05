/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const focusCommand: SlashCommand = {
  name: 'focus',
  get description() {
    return t('toggle focus mode (hide reasoning and tool call noise)');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  canRunDuringStreaming: true,
  action: async (context, _args) => {
    if (!context.ui.toggleFocusMode) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Focus mode is not supported by this renderer.'),
      };
    }
    const enabled = await context.ui.toggleFocusMode();

    return {
      type: 'message',
      messageType: 'info',
      content: enabled
        ? t(
            'Focus mode enabled. Reasoning and completed tool calls are hidden. Run /focus again to disable, or press Ctrl+O for the full transcript.',
          )
        : t('Focus mode disabled.'),
    };
  },
};
