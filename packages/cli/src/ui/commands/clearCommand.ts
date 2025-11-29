/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';

export const clearCommand: SlashCommand = {
  name: 'clear',
  altNames: ['reset', 'new'],
  get description() {
    return t('Clear conversation history and free up context');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, _args) => {
    const { config } = context.services;

    if (config) {
      const newSessionId = config.startNewSession();

      // Reset UI telemetry metrics for the new session
      uiTelemetryService.reset();

      if (newSessionId && context.session.startNewSession) {
        context.session.startNewSession(newSessionId);
      }

      const geminiClient = config.getGeminiClient();
      if (geminiClient) {
        context.ui.setDebugMessage(
          t('Starting a new session, resetting chat, and clearing terminal.'),
        );
        // If resetChat fails, the exception will propagate and halt the command,
        // which is the correct behavior to signal a failure to the user.
        await geminiClient.resetChat();
      } else {
        context.ui.setDebugMessage(t('Starting a new session and clearing.'));
      }
    } else {
      context.ui.setDebugMessage(t('Starting a new session and clearing.'));
    }

    context.ui.clear();
  },
};
