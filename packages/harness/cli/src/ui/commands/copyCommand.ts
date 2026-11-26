/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import {
  BRAND_CLI_SLUG,
  getErrorMessage,
  type Message,
} from '@qwen-code/core';
import { marked, type Tokens } from 'marked';
import stringWidth from 'string-width';
import { SettingScope } from '../../config/settings.js';
import {
  CopyDialog,
  type CopyDialogSelection,
} from '../components/CopyDialog.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';

const RESPONSE_FILENAME = 'response.md';
const MAX_LOOKBACK = 20;
const COPY_DIALOG_MAX_LABEL_WIDTH = 60;

type CodeBlock = {
  code: string;
  lang?: string;
};

type SelectionContent = {
  text: string;
  filename: string;
};

function countOccurrences(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while (true) {
    const foundIndex = text.indexOf(needle, index);
    if (foundIndex === -1) {
      return count;
    }

    count += 1;
    index = foundIndex + needle.length;
  }
}

function getConversationMessages(context: CommandContext): Message[] {
  if (!Array.isArray(context.messages)) {
    return [];
  }

  return context.messages as Message[];
}

function extractAssistantText(
  message: Extract<Message, { type: 'assistant' }>,
): string {
  return message.message.content
    .filter(
      (
        block,
      ): block is Extract<
        Extract<Message, { type: 'assistant' }>['message']['content'][number],
        { type: 'text' }
      > => block.type === 'text' && block.text.trim().length > 0,
    )
    .map((block) => block.text)
    .join('\n\n');
}

export function collectRecentAssistantTexts(
  messages: readonly Message[],
): string[] {
  const texts: string[] = [];

  for (
    let i = messages.length - 1;
    i >= 0 && texts.length < MAX_LOOKBACK;
    i--
  ) {
    const message = messages[i];
    if (!message || message.type !== 'assistant') {
      continue;
    }

    const text = extractAssistantText(message);
    if (text) {
      texts.push(text);
    }
  }

  return texts;
}

export function extractCodeBlocks(markdown: string): CodeBlock[] {
  return marked.lexer(markdown).flatMap((token) =>
    token.type === 'code'
      ? [
          {
            code: (token as Tokens.Code).text,
            lang: (token as Tokens.Code).lang,
          },
        ]
      : [],
  );
}

export function fileExtension(lang: string | undefined): string {
  if (!lang) {
    return '.txt';
  }

  const sanitized = lang.replace(/[^a-zA-Z0-9]/g, '');
  if (!sanitized || sanitized === 'plaintext') {
    return '.txt';
  }

  return `.${sanitized}`;
}

function truncateLine(text: string, maxWidth: number): string {
  const firstLine = text.split('\n')[0] ?? '';
  if (stringWidth(firstLine) <= maxWidth) {
    return firstLine;
  }

  let width = 0;
  let result = '';
  const targetWidth = Math.max(maxWidth - 1, 0);

  for (const char of firstLine) {
    const charWidth = stringWidth(char);
    if (width + charWidth > targetWidth) {
      break;
    }
    result += char;
    width += charWidth;
  }

  return `${result}\u2026`;
}

async function writeCopyFile(text: string, filename: string): Promise<string> {
  const copyDir = path.join(os.tmpdir(), `${BRAND_CLI_SLUG}-copy`);
  const filePath = path.join(copyDir, filename);
  await fs.mkdir(copyDir, { recursive: true });
  await fs.writeFile(filePath, text, 'utf8');
  return filePath;
}

function formatCopySuccess(text: string, filePath?: string): string {
  const lineCount = countOccurrences(text, '\n') + 1;
  const charCount = text.length;
  const copied = `Copied to clipboard (${charCount} characters, ${lineCount} lines)`;

  return filePath ? `${copied}\nAlso written to ${filePath}` : copied;
}

async function copyAndPersist(
  text: string,
  filename: string,
  context: CommandContext,
): Promise<string> {
  await copyToClipboard(text, context.services.settings.merged);

  try {
    const filePath = await writeCopyFile(text, filename);
    return formatCopySuccess(text, filePath);
  } catch {
    return formatCopySuccess(text);
  }
}

function buildDialogItems(
  fullText: string,
  codeBlocks: readonly CodeBlock[],
): Array<{
  key: string;
  label: string;
  sublabel?: string;
  value: CopyDialogSelection;
}> {
  const lineCount = countOccurrences(fullText, '\n') + 1;
  const items = [
    {
      key: 'full',
      label: 'Full response',
      sublabel: `${fullText.length} chars, ${lineCount} lines`,
      value: 'full' as const,
    },
    ...codeBlocks.map((block, index) => {
      const blockLines = countOccurrences(block.code, '\n') + 1;
      const parts = [
        block.lang,
        blockLines > 1 ? `${blockLines} lines` : undefined,
      ].filter(Boolean);

      return {
        key: `code-${index}`,
        label: truncateLine(block.code, COPY_DIALOG_MAX_LABEL_WIDTH),
        sublabel: parts.length > 0 ? parts.join(', ') : undefined,
        value: index,
      };
    }),
    {
      key: 'always',
      label: 'Always copy full response',
      sublabel: 'Skip this picker in the future',
      value: 'always' as const,
    },
  ];

  return items;
}

function getSelectionContent(
  selection: CopyDialogSelection,
  fullText: string,
  codeBlocks: readonly CodeBlock[],
): SelectionContent {
  if (selection === 'full' || selection === 'always') {
    return {
      text: fullText,
      filename: RESPONSE_FILENAME,
    };
  }

  const block = codeBlocks[selection];
  if (!block) {
    throw new Error(`Invalid copy selection: ${selection}`);
  }

  return {
    text: block.code,
    filename: `copy${fileExtension(block.lang)}`,
  };
}

async function runDialogAction(
  context: CommandContext,
  action: () => Promise<string>,
): Promise<void> {
  try {
    const text = await action();
    context.ui.addItem({ type: 'info', text }, Date.now());
  } catch (error) {
    context.ui.addItem(
      {
        type: 'error',
        text: `Failed to copy to the clipboard. ${getErrorMessage(error)}`,
      },
      Date.now(),
    );
  } finally {
    context.ui.removeComponent();
  }
}

function parseRequestedMessageAge(
  args: string,
  availableTexts: readonly string[],
): { age: number } | { error: SlashCommandActionReturn } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { age: 0 };
  }

  const nth = Number(trimmed);
  if (!Number.isInteger(nth) || nth < 1) {
    return {
      error: {
        type: 'message',
        messageType: 'error',
        content: `Usage: /copy [N] where N is 1 (latest), 2, 3, ... Got: ${trimmed}`,
      },
    };
  }

  if (nth > availableTexts.length) {
    return {
      error: {
        type: 'message',
        messageType: 'info',
        content: `Only ${availableTexts.length} assistant ${availableTexts.length === 1 ? 'message' : 'messages'} available to copy`,
      },
    };
  }

  return { age: nth - 1 };
}

export const copyCommand: SlashCommand = {
  name: 'copy',
  description:
    'Copy the last assistant response to clipboard, or /copy N for the Nth-latest',
  argumentHint: '[N]',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const texts = collectRecentAssistantTexts(getConversationMessages(context));
    if (texts.length === 0) {
      return {
        type: 'message',
        messageType: 'info',
        content: 'No assistant message to copy',
      };
    }

    const parsedAge = parseRequestedMessageAge(args, texts);
    if ('error' in parsedAge) {
      return parsedAge.error;
    }

    const fullText = texts[parsedAge.age];
    const codeBlocks = extractCodeBlocks(fullText);
    const copyFullResponse =
      Boolean(context.services.settings.merged.ui?.copyFullResponse) ||
      codeBlocks.length === 0;

    if (copyFullResponse) {
      try {
        const result = await copyAndPersist(
          fullText,
          RESPONSE_FILENAME,
          context,
        );
        return {
          type: 'message',
          messageType: 'info',
          content: result,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to copy to the clipboard. ${getErrorMessage(error)}`,
        };
      }
    }

    return {
      type: 'custom_dialog',
      component: createElement(CopyDialog, {
        items: buildDialogItems(fullText, codeBlocks),
        onCancel: () => {
          context.ui.removeComponent();
        },
        onCopySelection: (selection: CopyDialogSelection) =>
          runDialogAction(context, async () => {
            let preferenceSaved = false;
            if (selection === 'always') {
              preferenceSaved = context.services.settings.setValue(
                SettingScope.User,
                'ui.copyFullResponse',
                true,
              );
            }

            const content = getSelectionContent(
              selection,
              fullText,
              codeBlocks,
            );
            const result = await copyAndPersist(
              content.text,
              content.filename,
              context,
            );

            return selection === 'always' && preferenceSaved
              ? `${result}\nPreference saved. Use /settings to change it.`
              : result;
          }),
        onWriteSelection: (selection: CopyDialogSelection) =>
          runDialogAction(context, async () => {
            const content = getSelectionContent(
              selection,
              fullText,
              codeBlocks,
            );
            const filePath = await writeCopyFile(
              content.text,
              content.filename,
            );
            return `Written to ${filePath}`;
          }),
      }),
    };
  },
};
