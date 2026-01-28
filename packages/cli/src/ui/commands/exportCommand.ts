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
  collectSessionData,
  normalizeSessionData,
  toMarkdown,
  toHtml,
  toJson,
  toJsonl,
  generateExportFilename,
} from '../utils/export/index.js';

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

    // Collect and normalize export data (SSOT)
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config,
    );

    // Generate markdown from SSOT
    const markdown = toMarkdown(normalizedData);

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

    // Collect and normalize export data (SSOT)
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config,
    );

    // Generate HTML from SSOT
    const html = toHtml(normalizedData);

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
 * Action for the 'json' subcommand - exports session to JSON.
 */
async function exportJsonAction(
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

    // Collect and normalize export data (SSOT)
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config,
    );

    // Generate JSON from SSOT
    const json = toJson(normalizedData);

    const filename = generateExportFilename('json');
    const filepath = path.join(cwd, filename);

    // Write to file
    await fs.writeFile(filepath, json, 'utf-8');

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to JSON: ${filename}`,
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
 * Action for the 'jsonl' subcommand - exports session to JSONL.
 */
async function exportJsonlAction(
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

    // Collect and normalize export data (SSOT)
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config,
    );

    // Generate JSONL from SSOT
    const jsonl = toJsonl(normalizedData);

    const filename = generateExportFilename('jsonl');
    const filepath = path.join(cwd, filename);

    // Write to file
    await fs.writeFile(filepath, jsonl, 'utf-8');

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to JSONL: ${filename}`,
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
    {
      name: 'json',
      description: 'Export session to JSON format',
      kind: CommandKind.BUILT_IN,
      action: exportJsonAction,
    },
    {
      name: 'jsonl',
      description: 'Export session to JSONL format (one message per line)',
      kind: CommandKind.BUILT_IN,
      action: exportJsonlAction,
    },
  ],
};
