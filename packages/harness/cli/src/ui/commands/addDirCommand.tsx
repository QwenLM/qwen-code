/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import React from 'react';
import { getErrorMessage, isNetworkShapedPath } from '@qwen-code/core';
import { MessageType } from '../types.js';
import { CommandKind, type CommandContext, type SlashCommand } from './types.js';
import { resolvePath } from '../../utils/resolvePath.js';
import { getDirectoryCompletions } from '../../utils/directoryCompletions.js';
import { SettingScope } from '../../config/settings.js';
import {
  AddDirTrustSelector,
  type AddDirTrustChoice,
} from './AddDirTrustSelector.js';
import { AddWorkspaceDirectory } from '../components/permissions/AddWorkspaceDirectory.js';

const RESOURCE_RELOAD_PENDING_DELAY_MS = 100;
const RESOURCE_RELOAD_TIMEOUT_MS = 3000;

const listSubCommand: SlashCommand = {
  name: 'list',
  description: 'List all directories currently in the workspace context',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  takesArgs: false,
  action: (context) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: 'No active config.' },
        Date.now(),
      );
      return;
    }

    const dirs = config.getWorkspaceContext().getDirectories();
    const text =
      dirs.length === 0
        ? 'No workspace directories.'
        : `Workspace directories:\n${dirs.map((d) => `  ${d}`).join('\n')}`;

    context.ui.addItem({ type: MessageType.INFO, text }, Date.now());
  },
};

/**
 * Performs the actual workspace add: registers the directory with the
 * workspace context, mutates the in-memory permission context, persists
 * to settings.local.json when requested, and emits a confirmation message.
 *
 * Shared between the `/add-dir <path>` flow (path supplied directly) and
 * the `/add-dir` / Trust-tab flow (path collected from the interactive
 * AddWorkspaceDirectory dialog).
 */
async function performAddDirectory(
  context: CommandContext,
  resolvedPath: string,
  choice: AddDirTrustChoice,
): Promise<void> {
  const config = context.services.agentContext?.config;
  if (!config) return;

  const reloadDirectoryResources = async (): Promise<boolean> => {
    let pendingItemSet = false;
    let reloadTimeout: ReturnType<typeof setTimeout> | undefined;
    const pendingTimer = setTimeout(() => {
      if (context.ui.pendingItem === null) {
        pendingItemSet = true;
        context.ui.setPendingItem({
          type: MessageType.INFO,
          text: 'Refreshing skills...',
        });
      }
    }, RESOURCE_RELOAD_PENDING_DELAY_MS);

    try {
      const completed = await Promise.race([
        config.reloadSkills().then(() => true),
        new Promise<false>((resolve) => {
          reloadTimeout = setTimeout(
            () => resolve(false),
            RESOURCE_RELOAD_TIMEOUT_MS,
          );
        }),
      ]);

      if (!completed) {
        // Stop blocking the command without reporting success or failure. The
        // in-flight reload will publish its normal change event when done.
        return false;
      }

      // File-driven refreshes remain debounced, but /add-dir is an explicit
      // user action. Refresh its command view before completing so a newly
      // discovered skill can be invoked by the very next command.
      context.ui.reloadCommands();
      return true;
    } catch (err) {
      context.ui.addItem(
        {
          type: MessageType.WARNING,
          text: `Directory is trusted, but resources could not be refreshed: ${(err as Error).message}`,
        },
        Date.now(),
      );
      return false;
    } finally {
      clearTimeout(pendingTimer);
      if (reloadTimeout) {
        clearTimeout(reloadTimeout);
      }
      if (pendingItemSet) {
        context.ui.setPendingItem(null);
      }
    }
  };

  // An already-trusted directory may contain resources created since it was
  // first added, so refresh it without mutating permissions or settings again.
  if (config.permission?.getAdditionalDirectories().includes(resolvedPath)) {
    context.ui.addItem(
      {
        type: MessageType.WARNING,
        text: `Directory already trusted: ${resolvedPath}`,
      },
      Date.now(),
    );
    await reloadDirectoryResources();
    return;
  }

  // If local settings is read-only (home directory workspace), downgrade
  let effectiveChoice = choice;
  if (choice === 'persist' && context.services.settings.local?.readOnly) {
    effectiveChoice = 'memory';
    context.ui.addItem(
      {
        type: MessageType.WARNING,
        text: 'Cannot persist in this workspace (home directory) \u2014 added for this session only.',
      },
      Date.now(),
    );
  }

  if (effectiveChoice === 'persist') {
    const saved = context.services.settings.updateValue(
      SettingScope.Local,
      'permissions.additionalDirectories',
      (current) => {
        const existing = Array.isArray(current)
          ? current.filter(
              (entry): entry is string => typeof entry === 'string',
            )
          : [];
        return existing.includes(resolvedPath)
          ? existing
          : [...existing, resolvedPath];
      },
    );
    if (!saved) return;
  }

  try {
    config.getWorkspaceContext().addDirectory(resolvedPath);
  } catch (err) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: `Failed to add directory: ${(err as Error).message}`,
      },
      Date.now(),
    );
    return;
  }

  const permission = config.permission;
  if (permission) {
    if (effectiveChoice === 'memory') {
      // Session-only: tracked so `/clear` drops it. Not persisted, so it does not
      // come back on reload — exactly what "this session only" means.
      permission.addDirectory(resolvedPath);
    } else {
      // Persisted: added to the live list and written to settings below. It
      // survives `/clear` because it is reloaded from settings.
      permission.setAdditionalDirectories([
        ...permission.getAdditionalDirectories(),
        resolvedPath,
      ]);
    }
  }

  const resourcesReloaded = await reloadDirectoryResources();

  if (resourcesReloaded && effectiveChoice === choice) {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text:
          effectiveChoice === 'persist'
            ? `Added and trusted directory (persisted): ${resolvedPath}`
            : `Added and trusted directory (this session only): ${resolvedPath}`,
      },
      Date.now(),
    );
  }
}

export const addDirCommand: SlashCommand = {
  name: 'add-dir',
  description: 'Add a directory to the workspace context',
  kind: CommandKind.BUILT_IN,
  takesArgs: true,
  argumentHint: '[directory]',
  subCommands: [listSubCommand],
  showCompletionLoading: false,
  completion: (_context, partialArg) => getDirectoryCompletions(partialArg),
  action: async (context, args) => {
    const trimmed = args.trim();
    const config = context.services.agentContext?.config;
    if (!config) {
      context.ui.addItem(
        { type: MessageType.ERROR, text: 'No active config.' },
        Date.now(),
      );
      return;
    }

    // No path supplied → open the interactive AddWorkspaceDirectory dialog.
    // It owns path entry (with directory completion suggestions) and the
    // trust-choice step, so the user can pick everything in one place.
    if (!trimmed) {
      await new Promise<void>((resolve) => {
        context.ui.setCustomDialog(
          React.createElement(AddWorkspaceDirectory, {
            onSubmit: (
              resolvedPath: string,
              choice: AddDirTrustChoice,
            ) => {
              context.ui.setCustomDialog(null);
              void performAddDirectory(context, resolvedPath, choice)
                .catch((err) => {
                  context.ui.addItem(
                    {
                      type: MessageType.ERROR,
                      text: `Failed to add directory: ${getErrorMessage(err)}`,
                    },
                    Date.now(),
                  );
                })
                .finally(() => resolve());
            },
            onCancel: () => {
              context.ui.setCustomDialog(null);
              context.ui.addItem(
                { type: MessageType.INFO, text: 'Add directory cancelled.' },
                Date.now(),
              );
              resolve();
            },
          }),
        );
      });
      return;
    }

    // Path supplied → resolve / validate / show only the trust selector.
    let resolvedPath: string;
    try {
      // SECURITY: classify the supplied spelling before path.resolve — resolve
      // collapses `//srv/share` to `/srv/share` on POSIX, which would hide the
      // shape from every later check.
      const isNetwork = isNetworkShapedPath(trimmed);
      const absolutePath = isNetwork
        ? trimmed
        : path.resolve(config.getTargetDir(), resolvePath(trimmed));
      if (!fs.existsSync(absolutePath)) {
        throw new Error(`Directory does not exist: ${absolutePath}`);
      }
      const stats = fs.statSync(absolutePath);
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${absolutePath}`);
      }
      // A network location keeps the spelling the user typed: realpathSync
      // would resolve a DFS alias or a mapped drive to a different UNC host,
      // and the workspace entry would then not match the paths tools compare.
      resolvedPath = isNetwork ? absolutePath : fs.realpathSync(absolutePath);
    } catch (err) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: `Failed to add directory: ${(err as Error).message}`,
        },
        Date.now(),
      );
      return;
    }

    const choice = await new Promise<AddDirTrustChoice | null>((resolve) => {
      context.ui.setCustomDialog(
        React.createElement(AddDirTrustSelector, {
          directory: resolvedPath,
          onSelect: (selected: AddDirTrustChoice) => {
            context.ui.setCustomDialog(null);
            resolve(selected);
          },
          onClose: () => {
            context.ui.setCustomDialog(null);
            resolve(null);
          },
        }),
      );
    });

    if (choice === null) {
      context.ui.addItem(
        { type: MessageType.INFO, text: 'Add directory cancelled.' },
        Date.now(),
      );
      return;
    }

    await performAddDirectory(context, resolvedPath, choice);
  },
};
