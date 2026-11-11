/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { getErrorMessage, type Message } from '@qwen-code/core';
import { ExportDialog } from '../components/ExportDialog.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { formatRawCommandInput } from '../utils/commandFormat.js';
import {
  buildDefaultExportFilename,
  normalizeExportFilename,
  renderMessagesToPlainText,
} from '../utils/conversationExport.js';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';

async function writeExportFile(
  fileName: string,
  content: string,
): Promise<string> {
  const normalizedName = normalizeExportFilename(fileName);
  const filePath = path.resolve(process.cwd(), normalizedName);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

function getConversationMessages(
  context: CommandContext,
  commandName: string,
): Message[] {
  if (!Array.isArray(context.messages)) {
    return [];
  }

  const messages = [...(context.messages as Message[])];
  const invocation = context.invocation;
  if (!invocation || invocation.name !== commandName || messages.length === 0) {
    return messages;
  }

  const lastMessage = messages[messages.length - 1];
  const recordedCommandInput = formatRawCommandInput(invocation.raw);
  if (
    recordedCommandInput &&
    lastMessage?.type === 'system' &&
    lastMessage.subtype === 'local_command' &&
    lastMessage.content === recordedCommandInput
  ) {
    messages.pop();
  }

  return messages;
}

async function runAndDismiss(
  context: CommandContext,
  action: () => Promise<string>,
  errorVerb: string,
): Promise<void> {
  try {
    const successText = await action();
    context.ui.addItem({ type: 'info', text: successText }, Date.now());
  } catch (error) {
    context.ui.addItem(
      {
        type: 'error',
        text: `Failed to ${errorVerb} conversation: ${getErrorMessage(error)}`,
      },
      Date.now(),
    );
  } finally {
    context.ui.removeComponent();
  }
}

export const exportCommand: SlashCommand = {
  name: 'export',
  description: 'Export the current conversation to a file or clipboard',
  argumentHint: '[filename]',
  kind: CommandKind.BUILT_IN,
  autoExecute: false,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<SlashCommandActionReturn> => {
    const messages = getConversationMessages(context, exportCommand.name);
    const trimmedArgs = args.trim();

    if (trimmedArgs) {
      try {
        const content = await renderMessagesToPlainText(
          messages,
          context.services.settings,
        );
        const filePath = await writeExportFile(trimmedArgs, content);
        return {
          type: 'message',
          messageType: 'info',
          content: `Conversation exported to: ${filePath}`,
        };
      } catch (error) {
        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to export conversation: ${getErrorMessage(error)}`,
        };
      }
    }

    const defaultFilename = buildDefaultExportFilename(messages);

    return {
      type: 'custom_dialog',
      component: (
        <ExportDialog
          defaultFilename={defaultFilename}
          onCancel={() => {
            context.ui.removeComponent();
          }}
          onCopy={() =>
            runAndDismiss(
              context,
              async () => {
                const content = await renderMessagesToPlainText(
                  messages,
                  context.services.settings,
                );
                await copyToClipboard(
                  content,
                  context.services.settings.merged,
                );
                return 'Conversation copied to the clipboard';
              },
              'copy',
            )
          }
          onSave={(filename) =>
            runAndDismiss(
              context,
              async () => {
                const content = await renderMessagesToPlainText(
                  messages,
                  context.services.settings,
                );
                const filePath = await writeExportFile(filename, content);
                return `Conversation exported to: ${filePath}`;
              },
              'export',
            )
          }
        />
      ),
    };
  },
};
