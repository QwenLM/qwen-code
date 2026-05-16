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
  type ExportSessionData,
} from '../utils/export/index.js';
import { t } from '../../i18n/index.js';

type ExportFormat = {
  extension: string;
  displayName: string;
  format: (sessionData: ExportSessionData) => string;
};

function resolveExportTarget(cwd: string, args: string, extension: string) {
  const filename = generateExportFilename(extension);
  const outputDirArg = args.trim();
  const resolvedCwd = path.resolve(cwd);
  const outputDir = outputDirArg
    ? path.resolve(resolvedCwd, outputDirArg)
    : resolvedCwd;
  const filepath = path.join(outputDir, filename);
  const isDefaultOutputDir = outputDir === resolvedCwd;

  return {
    filename,
    filepath,
    outputDir,
    displayPath: isDefaultOutputDir ? filename : filepath,
    shouldCreateOutputDir: Boolean(outputDirArg && !isDefaultOutputDir),
  };
}

async function exportSessionAction(
  context: CommandContext,
  args: string,
  exportFormat: ExportFormat,
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

  let targetFilepath: string | undefined;

  try {
    // Load the current session using the current session ID
    const sessionService = new SessionService(cwd);
    const sessionId = config.getSessionId();
    const sessionData = await sessionService.loadSession(sessionId);

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

    const target = resolveExportTarget(cwd, args, exportFormat.extension);
    targetFilepath = target.filepath;
    const content = exportFormat.format(normalizedData);

    if (target.shouldCreateOutputDir) {
      await fs.mkdir(target.outputDir, { recursive: true });
    }
    await fs.writeFile(target.filepath, content, 'utf-8');

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to ${exportFormat.displayName}: ${target.displayPath}`,
    };
  } catch (error) {
    const destination = targetFilepath
      ? ` to ${exportFormat.displayName} at "${targetFilepath}"`
      : '';
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to export session${destination}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Action for the 'md' subcommand - exports session to markdown.
 */
async function exportMarkdownAction(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  return exportSessionAction(context, args, {
    extension: 'md',
    displayName: 'markdown',
    format: toMarkdown,
  });
}

/**
 * Action for the 'html' subcommand - exports session to HTML.
 */
async function exportHtmlAction(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  return exportSessionAction(context, args, {
    extension: 'html',
    displayName: 'HTML',
    format: toHtml,
  });
}

/**
 * Action for the 'json' subcommand - exports session to JSON.
 */
async function exportJsonAction(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  return exportSessionAction(context, args, {
    extension: 'json',
    displayName: 'JSON',
    format: toJson,
  });
}

/**
 * Action for the 'jsonl' subcommand - exports session to JSONL.
 */
async function exportJsonlAction(
  context: CommandContext,
  args: string,
): Promise<MessageActionReturn> {
  return exportSessionAction(context, args, {
    extension: 'jsonl',
    displayName: 'JSONL',
    format: toJsonl,
  });
}

/**
 * Main export command with subcommands.
 */
export const exportCommand: SlashCommand = {
  name: 'export',
  get description() {
    return t('Export current session message history to a file');
  },
  argumentHint: '[md|html|json|jsonl] [path]',
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
  action: exportHtmlAction,
  subCommands: [
    {
      name: 'html',
      get description() {
        return t('Export session to HTML format');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: exportHtmlAction,
    },
    {
      name: 'md',
      get description() {
        return t('Export session to markdown format');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: exportMarkdownAction,
    },
    {
      name: 'json',
      get description() {
        return t('Export session to JSON format');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: exportJsonAction,
    },
    {
      name: 'jsonl',
      get description() {
        return t('Export session to JSONL format (one message per line)');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'non_interactive', 'acp'] as const,
      action: exportJsonlAction,
    },
  ],
};
