/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { copyToClipboard } from '../utils/commandUtils.js';
import type { SlashCommand, SlashCommandActionReturn } from './types.js';
import { CommandKind } from './types.js';
import { t } from '../../i18n/index.js';

interface FencedCodeBlock {
  lang: string | null;
  content: string;
  index: number;
}

function parseFencedCodeBlocks(markdown: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  const fenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  let activeFence: string | null = null;
  let activeLang: string | null = null;
  let activeLines: string[] = [];

  for (const line of lines) {
    const match = line.match(fenceRegex);
    if (!activeFence) {
      if (match) {
        activeFence = match[1];
        activeLang = match[2]?.trim().split(/\s+/)[0]?.toLowerCase() || null;
        activeLines = [];
      }
      continue;
    }

    if (
      match &&
      match[1].startsWith(activeFence[0]) &&
      match[1].length >= activeFence.length
    ) {
      blocks.push({
        lang: activeLang,
        content: activeLines.join('\n'),
        index: blocks.length + 1,
      });
      activeFence = null;
      activeLang = null;
      activeLines = [];
      continue;
    }

    activeLines.push(line);
  }

  return blocks;
}

function selectCodeBlock(
  markdown: string,
  args: string,
): FencedCodeBlock | null | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() !== 'code') return undefined;

  const blocks = parseFencedCodeBlocks(markdown);
  if (blocks.length === 0) return null;

  let lang: string | null = null;
  let requestedIndex: number | null = null;
  for (const token of tokens.slice(1)) {
    if (/^\d+$/.test(token)) {
      requestedIndex = Number(token);
    } else {
      lang = token.toLowerCase();
    }
  }

  const candidates = lang
    ? blocks.filter((block) => block.lang === lang)
    : blocks;
  if (candidates.length === 0) return null;

  if (requestedIndex !== null) {
    const requested = lang
      ? candidates[requestedIndex - 1]
      : blocks.find((block) => block.index === requestedIndex);
    return requested ?? null;
  }

  return candidates[candidates.length - 1] ?? null;
}

export const copyCommand: SlashCommand = {
  name: 'copy',
  get description() {
    return t('Copy the last result or code snippet to clipboard');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (context, _args): Promise<SlashCommandActionReturn | void> => {
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

    if (lastAiOutput) {
      try {
        const selectedCodeBlock = selectCodeBlock(lastAiOutput, _args);
        if (selectedCodeBlock === null) {
          return {
            type: 'message',
            messageType: 'info',
            content: 'No matching code block found in the last AI output.',
          };
        }

        const copiedText = selectedCodeBlock?.content ?? lastAiOutput;
        await copyToClipboard(copiedText);

        return {
          type: 'message',
          messageType: 'info',
          content: selectedCodeBlock
            ? `Code block ${selectedCodeBlock.index} copied to the clipboard`
            : 'Last output copied to the clipboard',
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
    } else {
      return {
        type: 'message',
        messageType: 'info',
        content: 'Last AI output contains no text to copy.',
      };
    }
  },
};
