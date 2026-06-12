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

      const recordDream = async () =>
        config
          .getMemoryManager()
          .writeDreamManualRun(projectRoot, config.getSessionId());

      // Record the manual dream run only when the turn actually succeeds — a
      // failed or cancelled /dream (API error / SIGINT abort / token limit)
      // must not persist a consolidation record as if it had completed. Both
      // execution modes honor this: interactive fires onComplete via
      // useGeminiStream, and ACP fires it via Session.ts's pendingSlashOnComplete
      // (captured from the submit_prompt result), so the guard applies uniformly
      // instead of eagerly writing before the turn has run.
      return {
        type: 'submit_prompt',
        content: prompt,
        onComplete: async (opts?: {
          errored?: boolean;
          cancelled?: boolean;
        }) => {
          if (opts?.errored || opts?.cancelled) return;
          await recordDream();
        },
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
