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
import { isSubpath, SessionService } from '@qwen-code/qwen-code-core';
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

const EXPORT_DIR_OUT_OF_CWD =
  'Export directory must be within the project working directory.';

function resolveExportTarget(cwd: string, args: string, extension: string) {
  const filename = generateExportFilename(extension);
  const outputDirArg = args.trim();
  const resolvedCwd = path.resolve(cwd);
  const outputDir = outputDirArg
    ? path.resolve(resolvedCwd, outputDirArg)
    : resolvedCwd;
  const filepath = path.join(outputDir, filename);
  const isDefaultOutputDir = outputDir === resolvedCwd;
  const isInsideCwd = isSubpath(resolvedCwd, outputDir);

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
}): Promise<MessageActionReturn | undefined> {
  const [realCwd, realOutputDir] = await Promise.all([
    fs.realpath(target.resolvedCwd),
    fs.realpath(target.outputDir),
  ]);

  if (!isSubpath(realCwd, realOutputDir)) {
    return {
      type: 'message',
      messageType: 'error',
      content: `${EXPORT_DIR_OUT_OF_CWD} (target path resolves outside cwd via symlink)`,
    };
  }

  return undefined;
}

async function realpathNearestExisting(
  outputDir: string,
  resolvedCwd: string,
): Promise<string> {
  let currentPath = outputDir;

  while (isSubpath(resolvedCwd, currentPath)) {
    try {
      return await fs.realpath(currentPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }
  }

  throw new Error(
    `Cannot resolve any existing ancestor within cwd: ${resolvedCwd}`,
  );
}

async function validateExistingExportParentWithinCwd(target: {
  outputDir: string;
  resolvedCwd: string;
}): Promise<MessageActionReturn | undefined> {
  const [realCwd, realExistingParent] = await Promise.all([
    fs.realpath(target.resolvedCwd),
    realpathNearestExisting(target.outputDir, target.resolvedCwd),
  ]);

  if (!isSubpath(realCwd, realExistingParent)) {
    return {
      type: 'message',
      messageType: 'error',
      content: `${EXPORT_DIR_OUT_OF_CWD} (parent path resolves outside cwd via symlink)`,
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
      content: `${EXPORT_DIR_OUT_OF_CWD} (target path is outside cwd)`,
    };
  }

  try {
    const initialValidationError = target.shouldCreateOutputDir
      ? await validateExistingExportParentWithinCwd(target)
      : await validateExportTargetWithinCwd(target);
    if (initialValidationError) {
      return initialValidationError;
    }

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
      await fs.mkdir(target.outputDir, { recursive: true });
    }

    // Collect and normalize export data (SSOT)
    const exportData = await collectSessionData(conversation, config);
    const normalizedData = normalizeSessionData(
      exportData,
      conversation.messages,
      config,
    );

    const content = exportFormat.format(normalizedData);

    const writeValidationError = await validateExportTargetWithinCwd(target);
    if (writeValidationError) {
      return writeValidationError;
    }

    try {
      await fs.writeFile(target.filepath, content, 'utf-8');
    } catch (error) {
      return {
        type: 'message',
        messageType: 'error',
        content: `Failed to export session: ${error instanceof Error ? error.message : String(error)} (${exportFormat.displayName} target: "${targetFilepath}")`,
      };
    }

    return {
      type: 'message',
      messageType: 'info',
      content: `Session exported to ${exportFormat.displayName}: ${target.displayPath}`,
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
