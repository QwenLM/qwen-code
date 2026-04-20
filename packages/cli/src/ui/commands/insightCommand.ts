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
import { StaticInsightGenerator } from '../../services/insight/generators/StaticInsightGenerator.js';
import {
  createDebugLogger,
  encodeInsightProgressMessage,
  encodeInsightReadyMessage,
  Storage,
} from '@qwen-code/qwen-code-core';
import open from 'open';

const logger = createDebugLogger('DataProcessor');

export const insightCommand: SlashCommand = {
  name: 'insight',
  get description() {
    return t(
      'generate personalized programming insights from your chat history',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context: CommandContext) => {
    try {
      context.ui.setDebugMessage(t('Generating insights...'));

      const projectsDir = join(Storage.getRuntimeBaseDir(), 'projects');
      if (!context.services.config) {
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: 'Config service is not available.',
          };
        }
        throw new Error('Config service is not available');
      }
      const insightGenerator = new StaticInsightGenerator(
        context.services.config,
      );

      if (context.executionMode !== 'interactive') {
        const pendingMessages: Array<{
          messageType: 'info' | 'error';
          content: string;
        }> = [];
        let isComplete = false;
        let resume: (() => void) | null = null;

        const flushResume = () => {
          const resolve = resume;
          if (!resolve) {
            return;
          }
          resume = null;
          resolve();
        };

        const pushMessage = (message: {
          messageType: 'info' | 'error';
          content: string;
        }) => {
          pendingMessages.push(message);
          flushResume();
        };

        const streamMessages = async function* (): AsyncGenerator<
          { messageType: 'info' | 'error'; content: string },
          void,
          unknown
        > {
          while (!isComplete || pendingMessages.length > 0) {
            if (pendingMessages.length === 0) {
              await new Promise<void>((resolve) => {
                resume = resolve;
              });
            }

            while (pendingMessages.length > 0) {
              const message = pendingMessages.shift();
              if (message) {
                yield message;
              }
            }
          }
        };

        void (async () => {
          try {
            pushMessage({
              messageType: 'info',
              content: t('This may take a couple minutes. Sit tight!'),
            });
            pushMessage({
              messageType: 'info',
              content: encodeInsightProgressMessage(
                t('Starting insight generation...'),
                0,
              ),
            });

            const outputPath = await insightGenerator.generateStaticInsight(
              projectsDir,
              (stage, progress, detail) => {
                pushMessage({
                  messageType: 'info',
                  content: encodeInsightProgressMessage(
                    stage,
                    progress,
                    detail,
                  ),
                });
              },
            );

            pushMessage({
              messageType: 'info',
              content: encodeInsightReadyMessage(outputPath),
            });
          } catch (error) {
            pushMessage({
              messageType: 'error',
              content: t('Failed to generate insights: {{error}}', {
                error: (error as Error).message,
              }),
            });
            logger.error('Insight generation error:', error);
          } finally {
            isComplete = true;
            flushResume();
          }
        })();

        return {
          type: 'stream_messages',
          messages: streamMessages(),
        };
      }

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

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('This may take a couple minutes. Sit tight!'),
        },
        Date.now(),
      );

      updateProgress(t('Starting insight generation...'), 0);

      const outputPath = await insightGenerator.generateStaticInsight(
        projectsDir,
        updateProgress,
      );

      context.ui.setPendingItem(null);

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Insight report generated successfully!'),
        },
        Date.now(),
      );

      try {
        await open(outputPath);

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
      return;
    } catch (error) {
      context.ui.setPendingItem(null);

      if (context.executionMode !== 'interactive') {
        return {
          type: 'message' as const,
          messageType: 'error' as const,
          content: `Failed to generate insights: ${(error as Error).message}`,
        };
      }

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
      return;
    }
    return;
  },
};
