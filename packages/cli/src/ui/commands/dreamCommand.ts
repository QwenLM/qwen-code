/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { getAutoMemoryRoot, Storage } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import type { SlashCommand } from './types.js';
import { CommandKind } from './types.js';

export const dreamCommand: SlashCommand = {
  name: 'dream',
  get description() {
    return t('Consolidate managed auto-memory topic files.');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async (context) => {
    const config = context.services.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const projectRoot = config.getProjectRoot();
    const memoryRoot = getAutoMemoryRoot(projectRoot);
    const transcriptDir = path.join(
      new Storage(projectRoot).getProjectDir(),
      'chats',
    );

    const prompt = config
      .getMemoryManager()
      .buildConsolidationPrompt(memoryRoot, transcriptDir);

    // Record dream invocation eagerly so auto-dream dedup works in ACP mode
    // (where onComplete is not invoked by the session handler).
    await config
      .getMemoryManager()
      .writeDreamManualRun(projectRoot, config.getSessionId());

    return {
      type: 'submit_prompt',
      content: prompt,
      onComplete: async () => {
        await config
          .getMemoryManager()
          .writeDreamManualRun(projectRoot, config.getSessionId());
      },
    };
  },
};
