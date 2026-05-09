/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

export const branchCommand: SlashCommand = {
  name: 'branch',
  altNames: ['fork'],
  kind: CommandKind.BUILT_IN,
  get description() {
    return t('Fork the current conversation into a new session');
  },
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config is not available.'),
      };
    }

    // Guard: streaming or awaiting tool confirmation — forking mid-flight
    // would tear the new session's parent chain.
    if (context.ui.isIdleRef?.current === false) {
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Cannot branch while a response or tool call is in progress. Wait for it to finish or resolve the pending tool call.',
        ),
      };
    }

    // Guard: nothing to fork from.
    const sessionService = config.getSessionService();
    const currentId = config.getSessionId();
    const hasRecords = await sessionService.sessionExists(currentId);
    if (!hasRecords) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No conversation to branch.'),
      };
    }

    const name = args.trim().replace(/[\r\n]+/g, ' ');
    return (
      name
        ? { type: 'dialog', dialog: 'branch', name }
        : { type: 'dialog', dialog: 'branch' }
    ) as SlashCommandActionReturn;
  },
};
