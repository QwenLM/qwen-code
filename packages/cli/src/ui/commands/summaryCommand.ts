/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsPromises from 'fs/promises';
import path from 'path';
import {
  type SlashCommand,
  CommandKind,
  type SlashCommandActionReturn,
} from './types.js';
import { getProjectSummaryPrompt } from '@qwen-code/qwen-code-core';
import type { HistoryItemSummary } from '../types.js';

export const summaryCommand: SlashCommand = {
  name: 'summary',
  description:
    'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md',
  kind: CommandKind.BUILT_IN,
  action: async (context): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const { ui } = context;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      };
    }

    const geminiClient = config.getGeminiClient();
    if (!geminiClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No chat client available to generate summary.',
      };
    }

    // Check if already generating summary
    if (ui.pendingItem) {
      ui.addItem(
        {
          type: 'error' as const,
          text: 'Already generating summary, wait for previous request to complete',
        },
        Date.now(),
      );
      return {
        type: 'message',
        messageType: 'error',
        content:
          'Already generating summary, wait for previous request to complete',
      };
    }

    try {
      // Get the current chat history
      const chat = geminiClient.getChat();
      const history = chat.getHistory();

      if (history.length <= 2) {
        return {
          type: 'message',
          messageType: 'info',
          content: 'No conversation found to summarize.',
        };
      }

      // Show loading state
      const pendingMessage: HistoryItemSummary = {
        type: 'summary',
        summary: {
          isPending: true,
          stage: 'generating',
        },
      };
      ui.setPendingItem(pendingMessage);

      // Build the conversation context for summary generation
      const conversationContext = history.map((message) => ({
        role: message.role,
        parts: message.parts,
      }));

      // Use generateContent with chat history as context
      const response = await geminiClient.generateContent(
        [
          ...conversationContext,
          {
            role: 'user',
            parts: [
              {
                text: getProjectSummaryPrompt(),
              },
            ],
          },
        ],
        {},
        new AbortController().signal,
      );

      // Extract text from response
      const parts = response.candidates?.[0]?.content?.parts;

      const markdownSummary =
        parts
          ?.map((part) => part.text)
          .filter((text): text is string => typeof text === 'string')
          .join('') || '';

      if (!markdownSummary) {
        throw new Error(
          'Failed to generate summary - no text content received from LLM response',
        );
      }

      // Update loading message to show saving progress
      ui.setPendingItem({
        type: 'summary',
        summary: {
          isPending: true,
          stage: 'saving',
        },
      });

      // Ensure .qwen directory exists
      const projectRoot = config.getProjectRoot();
      const qwenDir = path.join(projectRoot, '.qwen');
      try {
        await fsPromises.mkdir(qwenDir, { recursive: true });
      } catch (_err) {
        // Directory might already exist, ignore error
      }

      // Save the summary to PROJECT_SUMMARY.md
      const summaryPath = path.join(qwenDir, 'PROJECT_SUMMARY.md');
      const summaryContent = `${markdownSummary}

---

## Summary Metadata
**Update time**: ${new Date().toISOString()} 
`;

      await fsPromises.writeFile(summaryPath, summaryContent, 'utf8');

      // Clear pending item and show success message
      ui.setPendingItem(null);
      const completedSummaryItem: HistoryItemSummary = {
        type: 'summary',
        summary: {
          isPending: false,
          stage: 'completed',
          filePath: '.qwen/PROJECT_SUMMARY.md',
        },
      };
      ui.addItem(completedSummaryItem, Date.now());

      return {
        type: 'message',
        messageType: 'info',
        content: '', // Empty content since we show the message in UI component
      };
    } catch (error) {
      // Clear pending item on error
      ui.setPendingItem(null);
      ui.addItem(
        {
          type: 'error' as const,
          text: `❌ Failed to generate project context summary: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
        Date.now(),
      );

      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to generate project context summary: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};
