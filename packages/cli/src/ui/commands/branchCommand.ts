/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CommandContext,
  SlashCommand,
  SlashCommandActionReturn,
} from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';
import { SessionService } from '@qwen-code/qwen-code-core';
import { resumeIntoSession } from './resumeSessionHelper.js';

export const branchCommand: SlashCommand = {
  name: 'branch',
  altNames: ['fork'],
  get description() {
    return t('Create a branch (fork) of the current conversation');
  },
  kind: CommandKind.BUILT_IN,
  action: branchAction,
};

async function branchAction(
  context: CommandContext,
  args: string,
): Promise<void | SlashCommandActionReturn> {
  const { config } = context.services;

  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('No active session to branch.'),
    };
  }

  const originalSessionId = config.getSessionId();
  const cwd = config.getTargetDir();
  const sessionService = new SessionService(cwd);
  const customTitle = args?.trim() || undefined;

  if (context.abortSignal?.aborted) return;

  // Fork the session
  const forkResult = await sessionService.forkSession(
    originalSessionId,
    customTitle ? { customTitle } : undefined,
  );

  if (!forkResult) {
    return {
      type: 'message',
      messageType: 'error',
      content: t('No conversation to branch.'),
    };
  }

  if (context.abortSignal?.aborted) return;

  // Load the forked session data for resume
  const sessionData = await sessionService.loadSession(forkResult.sessionId);

  if (!sessionData) {
    // Fork file was written but load failed — clean up the orphan
    await sessionService.removeSession(forkResult.sessionId);
    return {
      type: 'message',
      messageType: 'error',
      content: t('Failed to load branched session.'),
    };
  }

  // Resume into the forked session
  await resumeIntoSession(context, config, forkResult.sessionId, sessionData);

  // Show success message
  const titleInfo = customTitle ? ` "${customTitle}"` : '';
  context.ui.addItem(
    {
      type: 'info',
      text: t(
        `Branched conversation${titleInfo} as "${forkResult.title}". You are now in the branch.\nTo resume the original: /resume ${originalSessionId}`,
      ),
    },
    Date.now(),
  );
}
