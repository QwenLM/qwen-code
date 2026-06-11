/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, CommandContext } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadServerHierarchicalMemory,
  ConditionalRulesRegistry,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { SettingScope, saveSettings } from '../../config/settings.js';

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
export function getDirPathCompletions(partialArg: string): string[] {
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
      .map((e) => prefix + path.join(searchDir, e.name))
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
  supportedModes: ['interactive'] as const,
  subCommands: [
    {
      name: 'add',
      get description() {
        return t(
          'Add directories to the workspace. Use comma to separate multiple paths',
        );
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      completion: async (_context: CommandContext, partialArg: string) =>
        getDirPathCompletions(partialArg),
      action: async (context: CommandContext, args: string) => {
        const {
          ui: { addItem },
          services: { config, settings },
        } = context;
        const [...rest] = args.split(' ');

        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Configuration is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const workspaceContext = config.getWorkspaceContext();

        const pathsToAdd = rest
          .join(' ')
          .split(',')
          .filter((p) => p);
        if (pathsToAdd.length === 0) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Please provide at least one path to add.'),
            },
            Date.now(),
          );
          return;
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

        const added: string[] = [];
        const alreadyAdded: string[] = [];
        const errors: string[] = [];

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
              settings.workspace.originalSettings.context?.includeDirectories ??
              [];
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
                  'tree', // Use setting or default to 'tree'
                config.getContextRuleExcludes(),
              );
              config.setUserMemory(memoryContent);
              config.setGeminiMdFileCount(fileCount);
              config.setConditionalRulesRegistry(
                new ConditionalRulesRegistry(conditionalRules, projectRoot),
              );
              context.ui.setGeminiMdFileCount(fileCount);
            }
            addItem(
              {
                type: MessageType.INFO,
                text: t(
                  'Successfully added QWEN.md files from the following directories if there are:\n- {{directories}}',
                  {
                    directories: added.join('\n- '),
                  },
                ),
              },
              Date.now(),
            );
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
          addItem(
            {
              type: MessageType.INFO,
              text: t('Successfully added directories:\n- {{directories}}', {
                directories: added.join('\n- '),
              }),
            },
            Date.now(),
          );
        }

        if (alreadyAdded.length > 0) {
          const directories = Array.from(new Set(alreadyAdded));
          addItem(
            {
              type: MessageType.INFO,
              text: t('Directories already in workspace:\n- {{directories}}', {
                directories: directories.join('\n- '),
              }),
            },
            Date.now(),
          );
        }

        if (errors.length > 0) {
          addItem(
            { type: MessageType.ERROR, text: errors.join('\n') },
            Date.now(),
          );
        }
        return;
      },
    },
    {
      name: 'remove',
      get description() {
        return t('Remove a directory from the workspace');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      completion: async (context: CommandContext, partialArg: string) => {
        const { services } = context;
        if (!services.config) return [];
        if (services.config.isRestrictiveSandbox()) return [];
        const dirs = services.config.getWorkspaceContext().getDirectories();
        const initialSet = new Set(
          services.config.getWorkspaceContext().getInitialDirectories(),
        );
        const candidates = dirs.filter((d) => !initialSet.has(d));
        const prefix = partialArg?.trim() ?? '';
        if (!prefix) return candidates;
        return candidates.filter((d) => d.includes(prefix));
      },
      action: async (context: CommandContext, args: string) => {
        const {
          ui: { addItem },
          services: { config, settings },
        } = context;
        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Configuration is not available.'),
            },
            Date.now(),
          );
          return;
        }

        const directory = args.trim();
        if (!directory) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Please provide a directory path to remove.'),
            },
            Date.now(),
          );
          return;
        }

        if (config.isRestrictiveSandbox()) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'The /directory remove command is not supported in restrictive sandbox profiles. Please use --include-directories when starting the session instead.',
              ),
            },
            Date.now(),
          );
          return;
        }

        const workspaceContext = config.getWorkspaceContext();

        // Resolve to the same canonical (realpath) form that
        // WorkspaceContext stores internally, so the persistence filter
        // matches correctly even when the stored entry uses a symlink or
        // other non-canonical spelling.
        const expandedDir = expandHomeDir(directory);
        let canonicalDirectory: string;
        try {
          canonicalDirectory = fs.realpathSync(expandedDir);
        } catch {
          canonicalDirectory = path.isAbsolute(expandedDir)
            ? expandedDir
            : path.resolve(expandedDir);
        }

        if (workspaceContext.isInitialDirectory(expandedDir)) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'Cannot remove initial workspace directory: {{directory}}',
                { directory },
              ),
            },
            Date.now(),
          );
          return;
        }

        // Also check by normalized path in case realpathSync failed above
        // and the initial directory is stored under a different canonical
        // form (e.g. symlinked cwd).
        const normalizedExpanded = path.normalize(expandedDir);
        const initialDirs = workspaceContext.getInitialDirectories();
        if (initialDirs.some((d) => path.normalize(d) === normalizedExpanded)) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'Cannot remove initial workspace directory: {{directory}}',
                { directory },
              ),
            },
            Date.now(),
          );
          return;
        }

        // Persist removal to settings using a two-phase approach:
        // Phase 1 — compute new directory lists for each scope (async
        // parallel realpath resolution to avoid N+1 sync I/O).
        // Phase 2 — commit all scopes atomically so partial failures
        // can be rolled back cleanly.
        const targetDir = canonicalDirectory;
        let found = false;

        // Phase 1: compute pending changes for each scope.
        const pendingChanges: Array<{
          scope: SettingScope;
          dirs: string[];
        }> = [];
        for (const scope of [
          SettingScope.Workspace,
          SettingScope.User,
        ] as const) {
          const scopeDirs =
            settings.forScope(scope).originalSettings.context
              ?.includeDirectories ?? [];
          // Resolve all paths in parallel using async realpath to avoid
          // blocking the event loop with N+1 sync I/O.
          const resolutions = await Promise.all(
            scopeDirs.map(async (d: string) => {
              try {
                return {
                  original: d,
                  resolved: await fs.promises.realpath(expandHomeDir(d)),
                };
              } catch {
                return { original: d, resolved: null };
              }
            }),
          );
          const includeDirectories = resolutions
            .filter((r) => {
              const normalized = path.normalize(expandHomeDir(r.original));
              return (
                r.resolved !== targetDir &&
                r.original !== targetDir &&
                normalized !== targetDir
              );
            })
            .map((r) => r.original);
          if (includeDirectories.length < scopeDirs.length) {
            found = true;
            pendingChanges.push({ scope, dirs: includeDirectories });
          }
        }

        if (!found) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Directory not found in workspace: {{directory}}', {
                directory,
              }),
            },
            Date.now(),
          );
          return;
        }

        // Snapshot deep copies for rollback before any mutations.
        const workspaceBefore = {
          settings: structuredClone(settings.workspace.settings),
          originalSettings: structuredClone(
            settings.workspace.originalSettings,
          ),
        };
        const userBefore = {
          settings: structuredClone(settings.user.settings),
          originalSettings: structuredClone(settings.user.originalSettings),
        };

        // Phase 2: commit all scopes atomically.
        // setValue() writes to disk immediately, so on partial failure we
        // must also restore the disk files for already-committed scopes.
        const committed: SettingScope[] = [];
        try {
          for (const change of pendingChanges) {
            settings.setValue(
              change.scope,
              'context.includeDirectories',
              change.dirs,
            );
            committed.push(change.scope);
          }
        } catch (error) {
          // Always restore both scopes — setValue() modifies memory before
          // saveSettings(), so the failing scope is also dirty.
          settings.workspace.settings = workspaceBefore.settings;
          settings.workspace.originalSettings =
            workspaceBefore.originalSettings;
          settings.user.settings = userBefore.settings;
          settings.user.originalSettings = userBefore.originalSettings;
          // Re-write disk for scopes that were actually committed.
          for (const scope of committed) {
            try {
              if (scope === SettingScope.Workspace) {
                saveSettings(
                  settings.workspace,
                  workspaceBefore.originalSettings,
                );
              } else {
                saveSettings(settings.user, userBefore.originalSettings);
              }
            } catch {
              /* best-effort rollback */
            }
          }
          settings.recomputeMerged();
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Error updating settings: {{error}}', {
                error: error instanceof Error ? error.message : String(error),
              }),
            },
            Date.now(),
          );
          return;
        }

        // Now remove from memory — persisted settings are already updated.
        const removed = workspaceContext.removeDirectory(canonicalDirectory);
        if (!removed) {
          // Roll back persisted settings since in-memory removal failed.
          settings.workspace.settings = workspaceBefore.settings;
          settings.workspace.originalSettings =
            workspaceBefore.originalSettings;
          settings.user.settings = userBefore.settings;
          settings.user.originalSettings = userBefore.originalSettings;
          for (const scope of committed) {
            try {
              if (scope === SettingScope.Workspace) {
                saveSettings(
                  settings.workspace,
                  workspaceBefore.originalSettings,
                );
              } else {
                saveSettings(settings.user, userBefore.originalSettings);
              }
            } catch {
              /* best-effort rollback */
            }
          }
          settings.recomputeMerged();
          addItem(
            {
              type: MessageType.ERROR,
              text: t(
                'Could not remove directory from the active workspace. Settings were not changed.',
              ),
            },
            Date.now(),
          );
          return;
        }

        // Update the model's directory context so it's aware the
        // directory has been removed (mirrors the add path).
        const gemini = config.getGeminiClient();
        if (gemini) {
          await gemini.addDirectoryContext();
        }

        // Report success — the directory has been removed from both
        // persisted settings and in-memory workspace context.
        addItem(
          {
            type: MessageType.INFO,
            text: t('Removed directory: {{directory}}', { directory }),
          },
          Date.now(),
        );

        // Refresh hierarchical memory to drop QWEN.md content and
        // conditional rules that were loaded from the removed directory,
        // mirroring what the add path already does.
        // This is best-effort: a failure here does not roll back the
        // directory removal, but the user is warned that stale content
        // may remain for the rest of the session.
        if (config.shouldLoadMemoryFromIncludeDirectories()) {
          try {
            const { memoryContent, fileCount, conditionalRules, projectRoot } =
              await loadServerHierarchicalMemory(
                config.getWorkingDir(),
                config.getWorkspaceContext().getDirectories(),
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
          } catch (error) {
            addItem(
              {
                type: MessageType.WARNING,
                text: t(
                  'Directory removed but memory refresh failed: {{error}}',
                  {
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                ),
              },
              Date.now(),
            );
          }
        }
      },
    },
    {
      name: 'show',
      get description() {
        return t('Show all directories in the workspace');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: async (context: CommandContext) => {
        const {
          ui: { addItem },
          services: { config },
        } = context;
        if (!config) {
          addItem(
            {
              type: MessageType.ERROR,
              text: t('Configuration is not available.'),
            },
            Date.now(),
          );
          return;
        }
        const workspaceContext = config.getWorkspaceContext();
        const directories = workspaceContext.getDirectories();
        const directoryList = directories.map((dir) => `- ${dir}`).join('\n');
        addItem(
          {
            type: MessageType.INFO,
            text: t('Current workspace directories:\n{{directories}}', {
              directories: directoryList,
            }),
          },
          Date.now(),
        );
      },
    },
  ],
};
