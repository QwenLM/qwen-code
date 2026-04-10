/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAutoMemoryRoot } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';

export const rememberCommand: SlashCommand = {
  name: 'remember',
  get description() {
    return t('Save a durable memory to the memory system.');
  },
  kind: CommandKind.BUILT_IN,
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
    const useManagedMemory = config?.getManagedAutoMemoryEnabled() ?? false;

    if (useManagedMemory) {
      // In managed auto-memory mode the save_memory tool is not registered.
      // Submit a prompt so the main agent writes the per-entry file directly,
      // choosing the appropriate type (user / feedback / project / reference)
      // based on the content, following the instructions in buildManagedAutoMemoryPrompt.
      const memoryDir = config
        ? getAutoMemoryRoot(config.getProjectRoot())
        : undefined;
      const dirHint = memoryDir ? ` Save it to \`${memoryDir}\`.` : '';
      return {
        type: 'submit_prompt',
        content: `Please save the following to your memory system.${dirHint} Choose the most appropriate memory type (user, feedback, project, or reference) based on the content:\n\n${fact}`,
      };
    }

    // Legacy mode: save_memory tool is registered and handles the write.
    return {
      type: 'tool',
      toolName: 'save_memory',
      toolArgs: { fact },
    };
  },
};
