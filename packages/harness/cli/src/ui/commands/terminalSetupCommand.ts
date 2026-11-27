/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from './types.js';
import {
  formatTerminalSetupResultMessage,
  getTerminalProgram,
  terminalSetup,
} from '../utils/terminalSetup.js';
import { type MessageActionReturn } from '@qwen-code/core';

/**
 * Command to configure terminal keybindings for multiline input support.
 *
 * This command detects the active terminal and either installs supported
 * shortcuts, reports native support, or returns a manual fallback.
 */
export const terminalSetupCommand: SlashCommand = {
  name: 'terminal-setup',
  get description() {
    const terminal = getTerminalProgram();
    if (terminal === 'apple-terminal') {
      return 'Enable Option+Enter for newlines and disable the audible bell (skipped in screen-reader mode)';
    }
    if (
      terminal === 'ghostty' ||
      terminal === 'kitty' ||
      terminal === 'iterm2' ||
      terminal === 'wezterm' ||
      terminal === 'warp' ||
      terminal === 'windows-terminal'
    ) {
      return 'Check terminal shortcut support';
    }
    return 'Configure recommended terminal shortcuts';
  },
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  bridgeCommandType: 'local-jsx',
  action: async (context): Promise<MessageActionReturn> => {
    try {
      const result = await terminalSetup({
        screenReader:
          context.services.agentContext?.config.getScreenReader() ?? false,
      });
      return {
        type: 'message',
        content: formatTerminalSetupResultMessage(result),
        messageType: result.success ? 'info' : 'error',
      };
    } catch (error) {
      return {
        type: 'message',
        content: `Failed to configure terminal: ${error}`,
        messageType: 'error',
      };
    }
  },
};
