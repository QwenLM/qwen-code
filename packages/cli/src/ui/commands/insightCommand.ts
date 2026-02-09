/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import type { HistoryItemInsightProgress } from '../types.js';
import { t } from '../../i18n/index.js';
import { join } from 'path';
import os from 'os';
import { StaticInsightGenerator } from '../../services/insight/generators/StaticInsightGenerator.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const logger = createDebugLogger('DataProcessor');

// Open file in default browser
async function openFileInBrowser(filePath: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  // Convert to file:// URL for cross-platform compatibility
  const fileUrl = `file://${filePath.replace(/\\/g, '/')}`;

  try {
    switch (process.platform) {
      case 'darwin': // macOS
        await execAsync(`open "${fileUrl}"`);
        break;
      case 'win32': // Windows
        await execAsync(`start "" "${fileUrl}"`);
        break;
      default: // Linux and others
        await execAsync(`xdg-open "${fileUrl}"`);
    }
  } catch (_error) {
    // If opening fails, try with local file path
    switch (process.platform) {
      case 'darwin': // macOS
        await execAsync(`open "${filePath}"`);
        break;
      case 'win32': // Windows
        await execAsync(`start "" "${filePath}"`);
        break;
      default: // Linux and others
        await execAsync(`xdg-open "${filePath}"`);
    }
  }
}

export const insightCommand: SlashCommand = {
  name: 'insight',
  get description() {
    return t(
      'generate personalized programming insights from your chat history',
    );
  },
  kind: CommandKind.BUILT_IN,
  action: async (context: CommandContext) => {
    try {
      context.ui.setDebugMessage(t('Generating insights...'));

      const projectsDir = join(os.homedir(), '.qwen', 'projects');
      if (!context.services.config) {
        throw new Error('Config service is not available');
      }
      const insightGenerator = new StaticInsightGenerator(
        context.services.config,
      );

      const updateProgress = (
        stage: string,
        progress: number,
        detail?: string,
      ) => {
        const progressItem: HistoryItemInsightProgress = {
          type: MessageType.INSIGHT_PROGRESS,
          progress: {
            stage,
            progress,
            detail,
          },
        };
        context.ui.setPendingItem(progressItem);
      };

      // Initial progress
      updateProgress(t('Starting insight generation...'), 0);

      // Generate the static insight HTML file
      const outputPath = await insightGenerator.generateStaticInsight(
        projectsDir,
        updateProgress,
      );

      // Clear pending item
      context.ui.setPendingItem(null);

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Insight report generated successfully!'),
        },
        Date.now(),
      );

      // Open the file in the default browser
      try {
        await openFileInBrowser(outputPath);

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t('Opening insights in your browser: {{path}}', {
              path: outputPath,
            }),
          },
          Date.now(),
        );
      } catch (browserError) {
        logger.error('Failed to open browser automatically:', browserError);

        context.ui.addItem(
          {
            type: MessageType.INFO,
            text: t(
              'Insights generated at: {{path}}. Please open this file in your browser.',
              {
                path: outputPath,
              },
            ),
          },
          Date.now(),
        );
      }

      context.ui.setDebugMessage(t('Insights ready.'));
    } catch (error) {
      // Clear pending item on error
      context.ui.setPendingItem(null);

      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to generate insights: {{error}}', {
            error: (error as Error).message,
          }),
        },
        Date.now(),
      );

      logger.error('Insight generation error:', error);
    }
  },
};
