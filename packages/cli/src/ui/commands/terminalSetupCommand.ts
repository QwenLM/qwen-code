/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MessageActionReturn, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { terminalSetup } from '../utils/terminalSetup.js';
import { t } from '../../i18n/index.js';

/**
 * Command to configure terminal keybindings for multiline input support.
 *
 * This command automatically detects and configures terminals
 * to support Shift+Enter and Ctrl+Enter for multiline input.
 *
 * Supported: VS Code, Cursor, Windsurf, Trae, Alacritty, Zed, Apple Terminal
 * Native support (no setup needed): iTerm2, WezTerm, Ghostty, Kitty, Warp
 */
export const terminalSetupCommand: SlashCommand = {
  name: 'terminal-setup',
  get description() {
    return t(
      'Configure terminal keybindings for multiline input (Shift+Enter)',
    );
  },
  kind: CommandKind.BUILT_IN,

  action: async (): Promise<MessageActionReturn> => {
    try {
      const result = await terminalSetup();

      let content = result.message;
      if (result.requiresRestart) {
        content +=
          '\n\n' +
          t('Please restart your terminal for the changes to take effect.');
      }

      return {
        type: 'message',
        content,
        messageType: result.success ? 'info' : 'error',
      };
    } catch (error) {
      return {
        type: 'message',
        content: t('Failed to configure terminal: {{error}}', {
          error: String(error),
        }),
        messageType: 'error',
      };
    }
  },
};
