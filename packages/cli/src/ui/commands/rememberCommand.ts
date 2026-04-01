/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { t } from '../../i18n/index.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
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
    return t('Save a durable memory using the save_memory tool.');
  },
  kind: CommandKind.BUILT_IN,
  action: (_context, args): SlashCommandActionReturn | void => {
    const parsed = parseRememberArgs(args);
    if (!parsed?.fact) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Usage: /remember [--global|--project] <text to remember>'),
      };
    }

    return {
      type: 'tool',
      toolName: 'save_memory',
      toolArgs: parsed.scope
        ? { fact: parsed.fact, scope: parsed.scope }
        : { fact: parsed.fact },
    };
  },
};