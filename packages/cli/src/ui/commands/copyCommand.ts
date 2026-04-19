/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyToClipboard } from '../utils/commandUtils.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

/**
 * Extracts all fenced code blocks from a markdown string,
 * returning only the code content without the fence markers or language tags.
 */
export function extractCodeBlocks(markdown: string): string[] {
  const codeBlockRegex = /^```[^\n]*\n([\s\S]*?)^```/gm;
  const blocks: string[] = [];
  let match;
  while ((match = codeBlockRegex.exec(markdown)) !== null) {
    blocks.push(match[1].replace(/\n$/, ''));
  }
  return blocks;
}

export const copyCommand: SlashCommand = {
  name: 'copy',
  get description() {
    return t('Copy the last result or code snippet to clipboard');
  },
  kind: CommandKind.BUILT_IN,
  action: async (context, args): Promise<SlashCommandActionReturn | void> => {
    const chat = await context.services.config?.getGeminiClient()?.getChat();
    const history = chat?.getHistory();

    // Get the last message from the AI (model role)
    const lastAiMessage = history
      ? history.filter((item) => item.role === 'model').pop()
      : undefined;

    if (!lastAiMessage) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No output in history',
      };
    }
    // Extract text from the parts
    const lastAiOutput = lastAiMessage.parts
      ?.filter((part) => part.text)
      .map((part) => part.text)
      .join('');

    if (!lastAiOutput) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Last AI output contains no text to copy.',
      };
    }

    const trimmedArgs = args?.trim().toLowerCase() ?? '';
    let textToCopy: string;
    let successMessage: string;

    if (trimmedArgs === 'code') {
      // Extract only fenced code blocks, without line numbers or UI decorations
      const blocks = extractCodeBlocks(lastAiOutput);
      if (blocks.length === 0) {
        return {
          type: 'message',
          messageType: 'info',
          content: 'No code blocks found in the last AI output.',
        };
      }
      textToCopy = blocks.join('\n\n');
      successMessage =
        blocks.length === 1
          ? 'Code block copied to the clipboard'
          : `${blocks.length} code blocks copied to the clipboard`;
    } else {
      textToCopy = lastAiOutput;
      successMessage = 'Last output copied to the clipboard';
    }

    try {
      await copyToClipboard(textToCopy);

      return {
        type: 'message',
        messageType: 'info',
        content: successMessage,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.services.config?.getDebugLogger().debug(message);

      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to copy to the clipboard. ${message}`,
      };
    }
  },
};
