/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAutoMemoryRoot } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type { CommandContext, SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';

function parseRememberArgs(args: string):
  | { fact: string; scope?: 'global' | 'project' }
  | null {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return null;
  }

  if (trimmedArgs.startsWith('--global ')) {
    return {
      scope: 'global',
      fact: trimmedArgs.slice('--global '.length).trim(),
    };
  }

  if (trimmedArgs.startsWith('--project ')) {
    return {
      scope: 'project',
      fact: trimmedArgs.slice('--project '.length).trim(),
    };
  }

  if (trimmedArgs === '--global' || trimmedArgs === '--project') {
    return null;
  }

  return { fact: trimmedArgs };
}

export const rememberCommand: SlashCommand = {
  name: 'remember',
  get description() {
    return t('Save a durable memory to the memory system.');
  },
  kind: CommandKind.BUILT_IN,
  action: (context: CommandContext, args): SlashCommandActionReturn | void => {
    const parsed = parseRememberArgs(args);
    if (!parsed?.fact) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /remember [--global|--project] <text to remember>'),
      };
    }

    const config = context.services.config;
    const useManagedMemory = config?.getManagedAutoMemoryEnabled() ?? false;

    if (useManagedMemory) {
      // In managed auto-memory mode the save_memory tool is not registered.
      // Instead, submit a prompt so the main agent writes the per-entry file
      // directly, following the instructions in buildManagedAutoMemoryPrompt.
      const scopeHint = parsed.scope === 'project'
        ? ' (type: project)'
        : parsed.scope === 'global'
          ? ' (type: user)'
          : '';
      const memoryDir = config
        ? getAutoMemoryRoot(config.getProjectRoot())
        : undefined;
      const dirHint = memoryDir ? ` Save it to \`${memoryDir}\`.` : '';
      return {
        type: 'submit_prompt',
        content: `Please save the following to your memory system${scopeHint}:${dirHint}\n\n${parsed.fact}`,
      };
    }

    // Legacy mode: save_memory tool is registered and handles the write.
    return {
      type: 'tool',
      toolName: 'save_memory',
      toolArgs: parsed.scope
        ? { fact: parsed.fact, scope: parsed.scope }
        : { fact: parsed.fact },
    };
  },
};
