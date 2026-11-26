/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { performInit, type InitMode } from '@qwen-code/core';
import { InitModeSelector } from './InitModeSelector.js';

export const initCommand: SlashCommand = {
  name: 'init',
  description: 'Analyzes the project and creates a tailored context file',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (
    context: CommandContext,
    _args: string,
  ): Promise<SlashCommandActionReturn | void> => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Configuration not available.',
      };
    }

    if (!config.isInteractive()) {
      return performInit({
        mode: 'quick',
        contextFileName: config.getCurrentContextFileName(),
      });
    }

    // Wait for user to pick a mode via TUI before sending prompt
    const mode = await new Promise<InitMode | null>((resolve) => {
      context.ui.setCustomDialog(
        React.createElement(InitModeSelector, {
          contextFileName: config.getCurrentContextFileName(),
          onSelect: (selected: InitMode) => {
            context.ui.setCustomDialog(null);
            resolve(selected);
          },
          onClose: () => {
            context.ui.setCustomDialog(null);
            resolve(null);
          },
        }),
      );
    });

    if (mode === null) {
      return;
    }

    return performInit({
      mode,
      contextFileName: config.getCurrentContextFileName(),
    }) as SlashCommandActionReturn;
  },
};
