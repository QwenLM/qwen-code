/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CommandKind, type SlashCommand } from './types.js';
import { getSingleDirPathCompletions } from './directoryCommand.js';
import {
  isFolderTrustEnabled,
  loadTrustedFolders,
  TrustLevel,
} from '../../config/trustedFolders.js';
import { t } from '../../i18n/index.js';

const pendingTrustedPathConfirmations = new Map<string, string>();

function parsePathArgument(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\\([\\\s'"])/g, '$1');
}

function resolveCdPath(input: string, baseDir: string): string {
  if (input.includes('\0') || baseDir.includes('\0')) {
    throw new Error('Path contains null bytes.');
  }

  if (input === '~') {
    return path.normalize(os.homedir());
  }

  if (input.startsWith('~/')) {
    return path.normalize(path.join(os.homedir(), input.slice(2)));
  }

  if (path.isAbsolute(input)) {
    return path.normalize(input);
  }

  return path.resolve(baseDir, input);
}

export const cdCommand: SlashCommand = {
  name: 'cd',
  get description() {
    return t('Move this session to a new working directory');
  },
  kind: CommandKind.BUILT_IN,
  argumentHint: '<path>',
  supportedModes: ['interactive'] as const,
  completion: async (_context, partialArg) =>
    getSingleDirPathCompletions(partialArg),
  action: async (context, args) => {
    const targetArg = parsePathArgument(args);
    if (!targetArg) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: 'Usage: /cd <path>',
      };
    }

    const { config } = context.services;
    if (!config) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: 'Configuration is not available.',
      };
    }

    if (context.ui.isIdleRef.current === false) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content:
          'Cannot change directory while a response or tool call is in progress.',
      };
    }

    if (config.isRestrictiveSandbox()) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content:
          'The /cd command is not supported in restrictive sandbox profiles. Start a new session in the target directory instead.',
      };
    }

    const oldDir = config.getTargetDir();
    let targetPath: string;
    try {
      targetPath = resolveCdPath(targetArg, oldDir);
    } catch (error) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: error instanceof Error ? error.message : String(error),
      };
    }

    let stats;
    try {
      stats = await fs.stat(targetPath);
    } catch {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: `Couldn't find a directory at ${targetPath}.`,
      };
    }

    if (!stats.isDirectory()) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: `${targetPath} is not a directory.`,
      };
    }

    const [realOldDir, realTargetPath] = await Promise.all([
      fs.realpath(oldDir).catch(() => oldDir),
      fs.realpath(targetPath).catch(() => targetPath),
    ]);

    if (realTargetPath === realOldDir) {
      return {
        type: 'message' as const,
        messageType: 'info' as const,
        content: `Already in ${realTargetPath}.`,
      };
    }

    let trustedTargetPath: string | undefined;
    if (isFolderTrustEnabled(context.services.settings.merged)) {
      const trustedFolders = loadTrustedFolders();
      if (trustedFolders.isPathTrusted(realTargetPath) !== true) {
        const rawInvocation = context.invocation?.raw || `/cd ${targetArg}`;
        const confirmedPath =
          pendingTrustedPathConfirmations.get(rawInvocation);
        if (
          context.overwriteConfirmed &&
          confirmedPath &&
          confirmedPath === realTargetPath
        ) {
          pendingTrustedPathConfirmations.delete(rawInvocation);
          trustedTargetPath = realTargetPath;
        } else {
          pendingTrustedPathConfirmations.set(rawInvocation, realTargetPath);
          return {
            type: 'confirm_action' as const,
            prompt: `Move this session to ${realTargetPath}? Qwen Code will be able to read, edit, and execute files there. This folder will be trusted for future sessions.`,
            originalInvocation: {
              raw: rawInvocation,
            },
          };
        }
      }
    }

    const warnings: string[] = [];
    try {
      const relocation = await config.relocateWorkingDirectory(
        realTargetPath,
        realTargetPath,
      );
      if (relocation.memoryRefreshError) {
        warnings.push(
          `Memory refresh failed: ${
            relocation.memoryRefreshError instanceof Error
              ? relocation.memoryRefreshError.message
              : String(relocation.memoryRefreshError)
          }`,
        );
      }
    } catch (error) {
      return {
        type: 'message' as const,
        messageType: 'error' as const,
        content: `Couldn't move to ${realTargetPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (trustedTargetPath) {
      loadTrustedFolders().setValue(trustedTargetPath, TrustLevel.TRUST_FOLDER);
    }

    try {
      await config
        .getGeminiClient()
        ?.addWorkingDirectoryChangedContext(realOldDir, realTargetPath);
    } catch (error) {
      warnings.push(
        `Model context refresh failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      type: 'message' as const,
      messageType:
        warnings.length > 0 ? ('warning' as const) : ('info' as const),
      content:
        warnings.length > 0
          ? `Moved to ${realTargetPath}. ${warnings.join(' ')}`
          : `Moved to ${realTargetPath}.`,
    };
  },
};
