/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildBareRememberPrompt,
  buildManagedRememberPrompt,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

const debugLogger = createDebugLogger('REMEMBER_COMMAND');

export const rememberCommand: SlashCommand = {
  name: 'remember',
  get description() {
    return t('Save a durable memory to the memory system.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  argumentHint: '<text to remember>',
  action: (context: CommandContext, args): SlashCommandActionReturn | void => {
    const fact = args.trim();
    if (!fact) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /remember <text to remember>'),
      };
    }

    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const useManagedMemory = config?.isManagedMemoryAvailable() ?? false;

    if (useManagedMemory) {
      return {
        type: 'submit_prompt',
        content: buildManagedRememberPrompt(fact, config.getProjectRoot()),
        onComplete: async () => {
          try {
            await config.refreshHierarchicalMemory();
          } catch (err) {
            debugLogger.warn(
              `remember onComplete: refreshHierarchicalMemory failed: ${err}`,
            );
          }
          try {
            await config.getGeminiClient()?.refreshSystemInstruction();
          } catch (err) {
            debugLogger.warn(
              `remember onComplete: refreshSystemInstruction failed: ${err}`,
            );
          }
        },
      };
    }

    // --bare mode: ask the agent to save to QWEN.md using its native
    // file tools.
    return {
      type: 'submit_prompt',
      content: buildBareRememberPrompt(fact),
    };
  },
};
