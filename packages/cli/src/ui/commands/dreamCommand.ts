/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {
  createManualDreamToolInvocationGuard,
  getAutoMemoryRoot,
  Storage,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { MANUAL_DREAM_TOOL_GUARD_MARKER } from '../../utils/tool-invocation-guards.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

export const dreamCommand: SlashCommand = {
  name: 'dream',
  get description() {
    return t('Consolidate managed auto-memory topic files.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    try {
      const projectRoot = config.getProjectRoot();
      const memoryRoot = getAutoMemoryRoot(projectRoot);
      const transcriptDir = path.join(
        new Storage(projectRoot).getProjectDir(),
        'chats',
      );

      const prompt = config
        .getMemoryManager()
        .buildConsolidationPrompt(memoryRoot, transcriptDir);
      const toolInvocationGuard =
        createManualDreamToolInvocationGuard(projectRoot);

      const recordDream = async () =>
        config
          .getMemoryManager()
          .writeDreamManualRun(projectRoot, config.getSessionId());

      if (context.executionMode === 'acp') {
        recordDream().catch(() => {});
        return {
          type: 'submit_prompt',
          content: [{ text: MANUAL_DREAM_TOOL_GUARD_MARKER }, { text: prompt }],
          toolInvocationGuard,
        };
      }

      return {
        type: 'submit_prompt',
        content: [{ text: MANUAL_DREAM_TOOL_GUARD_MARKER }, { text: prompt }],
        onComplete: recordDream,
        toolInvocationGuard,
      };
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Failed to process /dream: {{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  },
};
