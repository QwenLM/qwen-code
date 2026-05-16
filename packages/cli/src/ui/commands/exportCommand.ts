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

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  );
}

function resolveExportTarget(cwd: string, args: string, extension: string) {
  const filename = generateExportFilename(extension);
  const outputDirArg = args.trim();
  const resolvedCwd = path.resolve(cwd);
  const outputDir = outputDirArg
    ? path.resolve(resolvedCwd, outputDirArg)
    : resolvedCwd;
  const filepath = path.join(outputDir, filename);
  const isDefaultOutputDir = outputDir === resolvedCwd;
  const isInsideCwd = isPathInside(resolvedCwd, outputDir);

  return {
    filepath,
    outputDir,
    displayPath: isDefaultOutputDir
      ? filename
      : path.join(outputDirArg, filename),
    resolvedCwd,
    shouldCreateOutputDir: Boolean(outputDirArg && !isDefaultOutputDir),
    isInsideCwd,
  };
}

async function validateExportTargetWithinCwd(target: {
  outputDir: string;
  resolvedCwd: string;
  isInsideCwd: boolean;
}): Promise<MessageActionReturn | undefined> {
  if (!target.isInsideCwd) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Export directory must be within the project working directory.',
    };
  }

  const [realCwd, realOutputDir] = await Promise.all([
    fs.realpath(target.resolvedCwd),
    fs.realpath(target.outputDir),
  ]);

  if (!isPathInside(realCwd, realOutputDir)) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Export directory must be within the project working directory.',
    };
  }

  return undefined;
}

async function realpathNearestExisting(
  outputDir: string,
  resolvedCwd: string,
): Promise<string> {
  let currentPath = outputDir;

  while (isPathInside(resolvedCwd, currentPath)) {
    try {
      return await fs.realpath(currentPath);
    } catch {
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }
  }

  return fs.realpath(resolvedCwd);
}

async function validateExistingExportParentWithinCwd(target: {
  outputDir: string;
  resolvedCwd: string;
}): Promise<MessageActionReturn | undefined> {
  const [realCwd, realExistingParent] = await Promise.all([
    fs.realpath(target.resolvedCwd),
    realpathNearestExisting(target.outputDir, target.resolvedCwd),
  ]);

  if (!isPathInside(realCwd, realExistingParent)) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Export directory must be within the project working directory.',
    };
  }

  return undefined;
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

  const target = resolveExportTarget(cwd, args, exportFormat.extension);
  const targetFilepath = target.filepath;
  if (!target.isInsideCwd) {
    return {
      type: 'message',
      messageType: 'error',
      content: 'Export directory must be within the project working directory.',
    };
  }

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

    if (target.shouldCreateOutputDir) {
      const parentValidationError =
        await validateExistingExportParentWithinCwd(target);
      if (parentValidationError) {
        return parentValidationError;
      }
      await fs.mkdir(target.outputDir, { recursive: true });
      const validationError = await validateExportTargetWithinCwd(target);
      if (validationError) {
        return validationError;
      }
    }

    // Collect and normalize export data (SSOT)
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config,
    );

    const content = exportFormat.format(normalizedData);

    await fs.writeFile(target.filepath, content, 'utf-8');

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to ${exportFormat.displayName}: ${target.displayPath}`,
    };
  } catch (error) {
    return {
      type: 'message',
      messageType: 'error',
      content: `Failed to export session: ${error instanceof Error ? error.message : String(error)} (${exportFormat.displayName} target: "${targetFilepath}")`,
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
