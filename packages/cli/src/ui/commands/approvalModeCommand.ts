/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  OpenDialogActionReturn,
  MessageActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import type { ApprovalMode} from '@qwen-code/qwen-code-core';
import { APPROVAL_MODES } from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';

/**
 * Parses the argument string and returns the corresponding ApprovalMode if valid.
 * Returns undefined if the argument is empty or not a valid mode.
 */
function parseApprovalModeArg(arg: string): ApprovalMode | undefined {
  const trimmed = arg.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  // Match against valid approval modes (case-insensitive)
  return APPROVAL_MODES.find((mode) => mode.toLowerCase() === trimmed);
}

export const approvalModeCommand: SlashCommand = {
  name: 'approval-mode',
  get description() {
    return t('View or change the approval mode for tool usage');
  },
  kind: CommandKind.BUILT_IN,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<OpenDialogActionReturn | MessageActionReturn> => {
    const mode = parseApprovalModeArg(args);

    // If no argument provided, open the dialog
    if (!args.trim()) {
      return {
        type: 'dialog',
        dialog: 'approval-mode',
      };
    }

    // If invalid argument, return error message with valid options
    if (!mode) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Invalid approval mode "{{arg}}". Valid modes: {{modes}}', {
          arg: args.trim(),
          modes: APPROVAL_MODES.join(', '),
        }),
      };
    }

    // Set the mode directly
    const { config, settings } = context.services;
    if (config && settings) {
      settings.setValue(SettingScope.User, 'tools.approvalMode', mode);
      config.setApprovalMode(settings.merged.tools?.approvalMode ?? mode);
    }

    return {
      type: 'message',
      messageType: 'info',
      content: t('Approval mode set to "{{mode}}"', { mode }),
    };
  },
  completion: async (
    _context: CommandContext,
    partialArg: string,
  ): Promise<string[]> => {
    const trimmed = partialArg.trim().toLowerCase();
    if (!trimmed) {
      return [...APPROVAL_MODES];
    }
    return APPROVAL_MODES.filter((mode) =>
      mode.toLowerCase().startsWith(trimmed),
    );
  },
};
