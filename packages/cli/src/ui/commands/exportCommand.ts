/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import {
  type CommandContext,
  type SlashCommand,
  type MessageActionReturn,
  CommandKind,
} from './types.js';
import { SessionService } from '@qwen-code/qwen-code-core';
import {
  transformToMarkdown,
  loadHtmlTemplate,
  prepareExportData,
  injectDataIntoHtmlTemplate,
  generateExportFilename,
} from '../utils/exportUtils.js';

/**
 * Action for the 'md' subcommand - exports session to markdown.
 */
async function exportMarkdownAction(
  context: CommandContext,
): Promise<MessageActionReturn> {
  const { services } = context;
  const { config } = services;

  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    };
  }

  const cwd = config.getWorkingDir() || config.getProjectRoot();
  if (!cwd) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Could not determine current working directory.',
    };
  }

  try {
    // Load the current session
    const sessionService = new SessionService(cwd);
    const sessionData = await sessionService.loadLastSession();

    if (!sessionData) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session found to export.',
      };
    }

    const { conversation } = sessionData;

    const markdown = transformToMarkdown(
      conversation.messages,
      conversation.sessionId,
      conversation.startTime,
    );

    const filename = generateExportFilename('md');
    const filepath = path.join(cwd, filename);

    // Write to file
    await fs.writeFile(filepath, markdown, 'utf-8');

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to markdown: ${filename}`,
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to export session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Action for the 'html' subcommand - exports session to HTML.
 */
async function exportHtmlAction(
  context: CommandContext,
): Promise<MessageActionReturn> {
  const { services } = context;
  const { config } = services;

  if (!config) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Configuration not available.',
    };
  }

  const cwd = config.getWorkingDir() || config.getProjectRoot();
  if (!cwd) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Could not determine current working directory.',
    };
  }

  try {
    // Load the current session
    const sessionService = new SessionService(cwd);
    const sessionData = await sessionService.loadLastSession();

    if (!sessionData) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'No active session found to export.',
      };
    }

    const { conversation } = sessionData;

    const template = await loadHtmlTemplate();
    const exportData = prepareExportData(conversation);
    const html = injectDataIntoHtmlTemplate(template, exportData);

    const filename = generateExportFilename('html');
    const filepath = path.join(cwd, filename);

    // Write to file
    await fs.writeFile(filepath, html, 'utf-8');

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to HTML: ${filename}`,
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to export session: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Main export command with subcommands.
 */
export const exportCommand: SlashCommand = {
  name: 'export',
  description: 'Export current session message history to a file',
  kind: CommandKind.BUILT_IN,
  subCommands: [
    {
      name: 'md',
      description: 'Export session to markdown format',
      kind: CommandKind.BUILT_IN,
      action: exportMarkdownAction,
    },
    {
      name: 'html',
      description: 'Export session to HTML format',
      kind: CommandKind.BUILT_IN,
      action: exportHtmlAction,
    },
  ],
};
