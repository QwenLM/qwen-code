/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message } from '../types.js';
import { MessageType } from '../types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { getAllMemoryFilenames } from '@qwen-code/qwen-code-core/utils/memory-constants.js';
import { t } from '../../i18n/index.js';

const debugLogger = createDebugLogger('SHOW_MEMORY');

export function createShowMemoryAction(
  config: Config | null,
  settings: LoadedSettings,
  addMessage: (message: Message) => void,
) {
  return async () => {
    if (!config) {
      addMessage({
        type: MessageType.ERROR,
        content: t('Configuration not available. Cannot show memory.'),
        timestamp: new Date(),
      });
      return;
    }

    debugLogger.debug('[DEBUG] Show Memory command invoked.');

    const contextMemory = config.getUserMemory();
    const autoMemoryPrompt = config.getAutoMemoryPrompt();
    const currentMemory = [
      contextMemory,
      autoMemoryPrompt,
      config.getAutoMemoryContext?.() ?? '',
    ]
      .filter((section) => section.trim().length > 0)
      .join('\n\n---\n\n');
    const fileCount = config.getMemoryFileCount();
    const contextFileName = settings.merged.context?.fileName;
    const contextFileNames = Array.isArray(contextFileName)
      ? contextFileName
      : contextFileName
        ? [contextFileName]
        : getAllMemoryFilenames();

    debugLogger.debug(
      `[DEBUG] Showing memory. Content from config.getUserMemory() (first 200 chars): ${currentMemory.substring(0, 200)}...`,
    );
    debugLogger.debug(`[DEBUG] Number of context files loaded: ${fileCount}`);

    if (fileCount > 0) {
      const allNamesTheSame = new Set(contextFileNames).size < 2;
      const name = allNamesTheSame
        ? (contextFileNames[0] ?? 'context')
        : 'context';
      addMessage({
        type: MessageType.INFO,
        content: t('Loaded memory from {{count}} {{name}} file{{plural}}.', {
          count: fileCount,
          name,
          plural: fileCount > 1 ? 's' : '',
        }),
        timestamp: new Date(),
      });
    }

    if (currentMemory && currentMemory.trim().length > 0) {
      addMessage({
        type: MessageType.INFO,
        content: t(
          'Current combined memory content:\n\`\`\`markdown\n{{content}}\n\`\`\`',
          { content: currentMemory },
        ),
        timestamp: new Date(),
      });
    } else {
      addMessage({
        type: MessageType.INFO,
        content:
          fileCount > 0
            ? t(
                'Hierarchical memory (QWEN.md or other context files) is loaded but content is empty.',
              )
            : t(
                'No hierarchical memory (QWEN.md or other context files) is currently loaded.',
              ),
        timestamp: new Date(),
      });
    }
  };
}
