/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
} from '@qwen-code/qwen-code-core';
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

    const useManagedMemory = config?.getManagedAutoMemoryEnabled() ?? false;

    if (useManagedMemory) {
      // In managed auto-memory mode the save_memory tool is not registered.
      // Submit a prompt so the main agent writes the per-entry file directly,
      // choosing the appropriate type (user / feedback / project / reference)
      // AND the appropriate scope (user-level for cross-project facts,
      // project-level for this-project-only facts) based on the content,
      // following the per-type `<scope>` guidance in buildManagedAutoMemoryPrompt.
      const projectDir = config
        ? getAutoMemoryRoot(config.getProjectRoot())
        : undefined;
      const userDir = getUserAutoMemoryRoot();
      const dirHint =
        projectDir !== undefined
          ? ` Choose the destination directory by the type's \`<scope>\`: USER memory at \`${userDir}\` for cross-project facts, PROJECT memory at \`${projectDir}\` for this-project-only facts.`
          : '';
      return {
        type: 'submit_prompt',
        content: `Please save the following to your memory system.${dirHint} Choose the most appropriate memory type (user, feedback, project, or reference) based on the content:\n\n${fact}`,
      };
    }

    // Managed auto-memory is disabled: ask the agent to save to QWEN.md
    // using its native file tools. We do not call save_memory because that
    // tool was removed.
    return {
      type: 'submit_prompt',
      content: `Please save the following fact to memory (e.g. append to QWEN.md in the project root):\n\n${fact}`,
    };
  },
};
