/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SlashCommand,
  CommandContext,
  CommandCompletionItem,
} from './types.js';
import { CommandKind } from './types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadServerHierarchicalMemory,
  ConditionalRulesRegistry,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { SettingScope } from '../../config/settings.js';

export function expandHomeDir(p: string): string {
  if (!p) {
    return '';
  }
  let expandedPath = p;
  if (p.toLowerCase().startsWith('%userprofile%')) {
    expandedPath = os.homedir() + p.substring('%userprofile%'.length);
  } else if (p === '~' || p.startsWith('~/')) {
    expandedPath = os.homedir() + p.substring(1);
  }
  return path.normalize(expandedPath);
}

function findExistingWorkspaceDirectory(
  directory: string,
  existingDirectories: Set<string>,
): string | undefined {
  if (existingDirectories.has(directory)) {
    return directory;
  }

  try {
    const absolutePath = path.isAbsolute(directory)
      ? directory
      : path.resolve(directory);
    const resolvedDirectory = fs.realpathSync(absolutePath);
    if (existingDirectories.has(resolvedDirectory)) {
      return resolvedDirectory;
    }
  } catch {
    // WorkspaceContext also skips unreadable paths; only report paths that
    // resolve to an existing workspace directory as already present.
  }

  return undefined;
}

/**
 * Returns directory path completions for the given partial argument.
 * Supports comma-separated paths by completing only the last segment.
 */
export function getDirPathCompletions(
  partialArg: string,
): CommandCompletionItem[] {
  const lastComma = partialArg.lastIndexOf(',');
  const prefix = lastComma >= 0 ? partialArg.substring(0, lastComma + 1) : '';
  const partial =
    lastComma >= 0
      ? partialArg.substring(lastComma + 1).trimStart()
      : partialArg;

  const trimmed = partial.trim();
  if (!trimmed) return [];

  const expanded = trimmed.startsWith('~')
    ? trimmed.replace(/^~/, os.homedir())
    : trimmed;
  const endsWithSep = expanded.endsWith('/') || expanded.endsWith(path.sep);
  const searchDir = endsWithSep ? expanded : path.dirname(expanded);
  const namePrefix = endsWithSep ? '' : path.basename(expanded);

  try {
    return fs
      .readdirSync(searchDir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          e.name.startsWith(namePrefix) &&
          !e.name.startsWith('.'),
      )
      .map((e) => ({
        value: prefix + path.join(searchDir, e.name) + path.sep,
        isDirectory: true,
      }))
      .slice(0, 8);
  } catch {
    return [];
  }
}

export const directoryCommand: SlashCommand = {
  name: 'directory',
  altNames: ['dir'],
  get description() {
    return t('Manage workspace directories');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'acp'] as const,
  action: async () => ({
    type: 'message' as const,
    messageType: 'info' as const,
    content: t('Usage: /directory add <path>[,<path>,...] or /directory show'),
  }),
  subCommands: [
    {
      name: 'add',
      get description() {
        return t(
          'Add directories to the workspace. Use comma to separate multiple paths',
        );
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'acp'] as const,
      argumentHint: '<path>[,<path>,...]',
      completion: async (_context: CommandContext, partialArg: string) =>
        getDirPathCompletions(partialArg),
      action: async (context: CommandContext, args: string) => {
        const { config, settings } = context.services;

        if (!config) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: t('Configuration is not available.'),
          };
        }

        const workspaceContext = config.getWorkspaceContext();

        const pathsToAdd = args.split(',').filter((p) => p.trim());
        if (pathsToAdd.length === 0) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: t('Please provide at least one path to add.'),
          };
        }

        if (config.isRestrictiveSandbox()) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: t(
              'The /directory add command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.',
            ),
          };
        }

        try {
          const added: string[] = [];
          const alreadyAdded: string[] = [];
          const errors: string[] = [];
          const messages: string[] = [];

          for (const pathToAdd of pathsToAdd) {
            const directory = expandHomeDir(pathToAdd.trim());
            const directoriesBeforeAdd = new Set(
              workspaceContext.getDirectories(),
            );
            try {
              workspaceContext.addDirectory(directory);
              const acceptedDirectories = workspaceContext
                .getDirectories()
                .filter((dir) => !directoriesBeforeAdd.has(dir));
              if (acceptedDirectories.length > 0) {
                added.push(...acceptedDirectories);
              } else {
                const existingDirectory = findExistingWorkspaceDirectory(
                  directory,
                  directoriesBeforeAdd,
                );
                if (existingDirectory) {
                  alreadyAdded.push(existingDirectory);
                }
              }
            } catch (e) {
              const error = e as Error;
              errors.push(
                t("Error adding '{{path}}': {{error}}", {
                  path: pathToAdd.trim(),
                  error: error.message,
                }),
              );
            }
          }

          if (added.length > 0) {
            try {
              const existingIncludeDirectories =
                settings.workspace.originalSettings.context
                  ?.includeDirectories ?? [];
              const includeDirectories = Array.from(
                new Set([...existingIncludeDirectories, ...added]),
              );
              settings.setValue(
                SettingScope.Workspace,
                'context.includeDirectories',
                includeDirectories,
              );
            } catch (error) {
              errors.push(
                t('Error saving directories to workspace settings: {{error}}', {
                  error: (error as Error).message,
                }),
              );
            }
          }

          if (added.length > 0) {
            try {
              if (config.shouldLoadMemoryFromIncludeDirectories()) {
                const {
                  memoryContent,
                  fileCount,
                  conditionalRules,
                  projectRoot,
                } = await loadServerHierarchicalMemory(
                  config.getWorkingDir(),
                  [...config.getWorkspaceContext().getDirectories(), ...added],
                  config.getFileService(),
                  config.getExtensionContextFilePaths(),
                  config.getFolderTrust(),
                  context.services.settings.merged.context?.importFormat ||
                    'tree',
                  config.getContextRuleExcludes(),
                );
                config.setUserMemory(memoryContent);
                config.setGeminiMdFileCount(fileCount);
                config.setConditionalRulesRegistry(
                  new ConditionalRulesRegistry(conditionalRules, projectRoot),
                );
                context.ui.setGeminiMdFileCount(fileCount);
                messages.push(
                  t(
                    'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}',
                    { directories: added.join('\n- ') },
                  ),
                );
              }
            } catch (error) {
              errors.push(
                t('Error refreshing memory: {{error}}', {
                  error: (error as Error).message,
                }),
              );
            }
          }

          if (added.length > 0) {
            const gemini = config.getGeminiClient();
            if (gemini) {
              await gemini.addDirectoryContext();
            }
            messages.push(
              t('Successfully added directories:\n- {{directories}}', {
                directories: added.join('\n- '),
              }),
            );
          }

          if (alreadyAdded.length > 0) {
            const directories = Array.from(new Set(alreadyAdded));
            messages.push(
              t('Directories already in workspace:\n- {{directories}}', {
                directories: directories.join('\n- '),
              }),
            );
          }

          if (errors.length > 0) {
            return {
              type: 'message' as const,
              messageType: 'error' as const,
              content: [...messages, ...errors].join('\n'),
            };
          }

          return {
            type: 'message' as const,
            messageType: 'info' as const,
            content: messages.join('\n') || t('No directories added.'),
          };
        } catch (error) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: t('Failed to process /directory add: {{message}}', {
              message: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
    {
      name: 'show',
      get description() {
        return t('Show all directories in the workspace');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive', 'acp'] as const,
      action: async (context: CommandContext) => {
        const { config } = context.services;
        if (!config) {
          return {
            type: 'message' as const,
            messageType: 'error' as const,
            content: t('Configuration is not available.'),
          };
        }
        const directories = config.getWorkspaceContext().getDirectories();
        const directoryList = directories.map((dir) => `- ${dir}`).join('\n');
        return {
          type: 'message' as const,
          messageType: 'info' as const,
          content: t('Current workspace directories:\n{{directories}}', {
            directories: directoryList,
          }),
        };
      },
    },
  ],
};
