/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  OpenDialogActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import type { MessageActionReturn } from '@qwen-code/core';

/**
 * Open the hooks management panel
 */
function panelAction(
  context: CommandContext,
): MessageActionReturn | OpenDialogActionReturn {
  const agentContext = context.services.agentContext;
  const config = agentContext?.config;
  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Config not loaded.',
    };
  }

  return { type: 'dialog', dialog: 'hookBrowser' };
}

export const hooksCommand: SlashCommand = {
  name: 'hooks',
  description: 'Open hooks management panel',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  autoExecute: true,
  action: panelAction,
};
