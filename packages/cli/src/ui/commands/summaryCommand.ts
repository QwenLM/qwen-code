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
import {
  getProjectSummaryPrompt,
  isSubpath,
  runSideQuery,
} from '@qwen-code/qwen-code-core';
import type { HistoryItemSummary } from '../types.js';
import { t } from '../../i18n/index.js';

// Resolves the real path of the nearest existing ancestor of targetPath. The
// target file itself usually does not exist yet, but a symlinked parent directory
// can still point outside the project root, so the ancestor must be resolved to
// detect that. Mirrors realpathNearestExisting in exportCommand.ts/statsCommand.ts.
const realpathNearestExisting = async (targetPath: string): Promise<string> => {
  let currentPath = targetPath;
  for (;;) {
    try {
      return await fsPromises.realpath(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return currentPath;
      }
      currentPath = parentPath;
    }
  }
};

export const summaryCommand: SlashCommand = {
  name: 'summary',
  get description() {
    return t(
      'Generate a project summary and save it to .qwen/PROJECT_SUMMARY.md',
    );
  },
  argumentHint: '[path]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: async (context, args): Promise<SlashCommandActionReturn> => {
    const { config } = context.services;
    const { ui } = context;
    const executionMode = context.executionMode ?? 'interactive';
    const abortSignal = context.abortSignal;

    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('Config not loaded.'),
      };
    }

    const geminiClient = config.getGeminiClient();
    if (!geminiClient) {
      return {
        type: 'message',
        messageType: 'error',
        content: t('No chat client available to generate summary.'),
      };
    }

    // Check if already generating summary (interactive UI only)
    if (executionMode === 'interactive' && ui.pendingItem) {
      ui.addItem(
        {
          type: 'error' as const,
          text: t(
            'Already generating summary, wait for previous request to complete',
          ),
        },
        Date.now(),
      );
      return {
        type: 'message',
        messageType: 'error',
        content: t(
          'Already generating summary, wait for previous request to complete',
        ),
      };
    }

    const getChatHistory = () => {
      const chat = geminiClient.getChat();
      return chat.getHistoryShallow();
    };

    const validateChatHistory = (
      history: ReturnType<typeof getChatHistory>,
    ) => {
      if (history.length <= 2) {
        throw new Error(t('No conversation found to summarize.'));
      }
    };

    const generateSummaryMarkdown = async (
      history: ReturnType<typeof getChatHistory>,
    ): Promise<string> => {
      // Build the conversation context for summary generation
      const conversationContext = history.map((message) => ({
        role: message.role,
        parts: message.parts,
      }));

      // Carry over the main session's system instruction. Without this the
      // model sees only chat history + the summary prompt, losing the coding-
      // assistant role, project context, and user memory. The chat sets it
      // as a string (see GeminiClient.getMainSessionSystemInstruction).
      const rawSystemInstruction = geminiClient
        .getChat()
        .getGenerationConfig().systemInstruction;
      const chatSystemInstruction =
        typeof rawSystemInstruction === 'string'
          ? rawSystemInstruction
          : undefined;

      const result = await runSideQuery(config, {
        purpose: 'project-summary',
        skipOutputLanguagePreference: true,
        model: config.getModel(),
        systemInstruction: chatSystemInstruction,
        contents: [
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
        abortSignal: abortSignal ?? new AbortController().signal,
      });

      if (!result.text) {
        throw new Error(
          t(
            'Failed to generate summary - no text content received from LLM response',
          ),
        );
      }

      return result.text;
    };

    const resolveSummaryTarget = async (): Promise<{
      summaryPath: string;
      filePathForDisplay: string;
    }> => {
      const projectRoot = config.getProjectRoot();
      const customPath = args?.trim();

      if (!customPath) {
        const qwenDir = path.join(projectRoot, '.qwen');
        return {
          summaryPath: path.join(qwenDir, 'PROJECT_SUMMARY.md'),
          filePathForDisplay: '.qwen/PROJECT_SUMMARY.md',
        };
      }

      const resolved = path.isAbsolute(customPath)
        ? customPath
        : path.resolve(projectRoot, customPath);

      if (!isSubpath(projectRoot, resolved)) {
        throw new Error(t('Summary path must be within the project root.'));
      }

      // A lexical check cannot see through symlinks: a link inside the project
      // root may point outside it. Re-check containment on the real paths.
      const realProjectRoot = await fsPromises.realpath(projectRoot);
      const realResolved = await realpathNearestExisting(resolved);
      if (!isSubpath(realProjectRoot, realResolved)) {
        throw new Error(t('Summary path must be within the project root.'));
      }

      const isDir =
        customPath.endsWith('/') ||
        customPath.endsWith(path.sep) ||
        (await fsPromises
          .stat(resolved)
          .then((s) => s.isDirectory())
          .catch(() => false));

      const summaryPath = isDir
        ? path.join(resolved, 'PROJECT_SUMMARY.md')
        : resolved;

      const filePathForDisplay = (
        path.isAbsolute(customPath)
          ? summaryPath
          : path.relative(projectRoot, summaryPath)
      ).replaceAll(path.sep, '/');

      return { summaryPath, filePathForDisplay };
    };

    const saveSummaryToDisk = async (
      markdownSummary: string,
      target: { summaryPath: string; filePathForDisplay: string },
    ): Promise<{
      filePathForDisplay: string;
      fullPath: string;
    }> => {
      const summaryContent = `${markdownSummary}

---

## Summary Metadata
**Update time**: ${new Date().toISOString()}
`;

      await fsPromises.mkdir(path.dirname(target.summaryPath), {
        recursive: true,
        mode: 0o700,
      });
      await fsPromises.writeFile(target.summaryPath, summaryContent, 'utf8');

      return {
        filePathForDisplay: target.filePathForDisplay,
        fullPath: target.summaryPath,
      };
    };

    const emitInteractivePending = (stage: 'generating' | 'saving') => {
      if (executionMode !== 'interactive') {
        return;
      }
      const pendingMessage: HistoryItemSummary = {
        type: 'summary',
        summary: {
          isPending: true,
          stage,
        },
      };
      ui.setPendingItem(pendingMessage);
    };

    const completeInteractive = (filePathForDisplay: string) => {
      if (executionMode !== 'interactive') {
        return;
      }
      ui.setPendingItem(null);
      const completedSummaryItem: HistoryItemSummary = {
        type: 'summary',
        summary: {
          isPending: false,
          stage: 'completed',
          filePath: filePathForDisplay,
        },
      };
      ui.addItem(completedSummaryItem, Date.now());
    };

    const formatErrorMessage = (error: unknown): string =>
      t('Failed to generate project context summary: {{error}}', {
        error: error instanceof Error ? error.message : String(error),
      });

    const failInteractive = (error: unknown) => {
      if (executionMode !== 'interactive') {
        return;
      }
      // If cancelled via ESC, don't show error — cancelSlashCommand already handled UI
      if (abortSignal?.aborted) {
        return;
      }
      ui.setPendingItem(null);
      ui.addItem(
        {
          type: 'error' as const,
          text: `✗ ${formatErrorMessage(error)}`,
        },
        Date.now(),
      );
    };

    const formatSuccessMessage = (filePathForDisplay: string): string =>
      t('Saved project summary to {{filePathForDisplay}}.', {
        filePathForDisplay,
      });

    const returnNoConversationMessage = (): SlashCommandActionReturn => {
      const msg = t('No conversation found to summarize.');
      if (executionMode === 'acp') {
        const messages = async function* () {
          yield {
            messageType: 'info' as const,
            content: msg,
          };
        };
        return {
          type: 'stream_messages',
          messages: messages(),
        };
      }
      return {
        type: 'message',
        messageType: 'info',
        content: msg,
      };
    };

    const executeSummaryGeneration = async (
      history: ReturnType<typeof getChatHistory>,
    ): Promise<{
      markdownSummary: string;
      filePathForDisplay: string;
    }> => {
      const target = await resolveSummaryTarget();
      emitInteractivePending('generating');
      const markdownSummary = await generateSummaryMarkdown(history);
      if (abortSignal?.aborted) {
        throw new DOMException('Summary generation cancelled.', 'AbortError');
      }
      emitInteractivePending('saving');
      const { filePathForDisplay } = await saveSummaryToDisk(
        markdownSummary,
        target,
      );
      completeInteractive(filePathForDisplay);
      return { markdownSummary, filePathForDisplay };
    };

    // Validate chat history once at the beginning
    const history = getChatHistory();
    try {
      validateChatHistory(history);
    } catch (_error) {
      return returnNoConversationMessage();
    }

    if (executionMode === 'acp') {
      const messages = async function* () {
        try {
          yield {
            messageType: 'info' as const,
            content: t('Generating project summary...'),
          };

          const { filePathForDisplay } =
            await executeSummaryGeneration(history);

          yield {
            messageType: 'info' as const,
            content: formatSuccessMessage(filePathForDisplay),
          };
        } catch (error) {
          failInteractive(error);
          yield {
            messageType: 'error' as const,
            content: formatErrorMessage(error),
          };
        }
      };

      return {
        type: 'stream_messages',
        messages: messages(),
      };
    }

    try {
      const { filePathForDisplay } = await executeSummaryGeneration(history);

      if (executionMode === 'non_interactive') {
        return {
          type: 'message',
          messageType: 'info',
          content: formatSuccessMessage(filePathForDisplay),
        };
      }

      // Interactive mode: UI components already display progress and completion.
      return {
        type: 'message',
        messageType: 'info',
        content: '',
      };
    } catch (error) {
      failInteractive(error);

      return {
        type: 'message',
        messageType: 'error',
        content: formatErrorMessage(error),
      };
    }
  },
};
