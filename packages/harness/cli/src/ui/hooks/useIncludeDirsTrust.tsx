/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import { useEffect } from 'react';
import {
  type Config,
  isFsTouchUnsafePath,
  isWithinRoot,
} from '@qwen-code/core';
import { expandHomeDir, batchAddDirectories } from '../utils/directoryUtils.js';
import { runLogger } from '@qwen-code/core';
import { MultiFolderTrustDialog } from '../components/MultiFolderTrustDialog.js';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';
import { MessageType, type HistoryItem } from '../types.js';
import type { LoadedSettings } from '../../config/settings.js';

/**
 * Checks whether a given path is within any of the additionalDirectories
 * entries from the merged settings. Uses `isWithinRoot` and `fs.realpathSync`
 * (via a safe helper) to resolve symlinks before comparing.
 */
function isPathInAdditionalDirectories(
  path: string,
  additionalDirs: string[],
): boolean {
  const realPathToAdd = getRealPath(expandHomeDir(path));
  for (const dir of additionalDirs) {
    const realDir = getRealPath(expandHomeDir(dir));
    if (isWithinRoot(realPathToAdd, realDir)) {
      return true;
    }
  }
  return false;
}

function getRealPath(location: string): string {
  // Keep the operator's spelling for network locations — realpathSync would
  // resolve a DFS alias or mapped drive to a different UNC host and
  // isWithinRoot would then miss. Mirrors config/trustedFolders.ts. It also
  // avoids the SMB/NTLM handshake the probe would perform.
  if (isFsTouchUnsafePath(location)) {
    return location;
  }
  try {
    return fs.existsSync(location) ? fs.realpathSync(location) : location;
  } catch {
    return location;
  }
}

async function finishAddingDirectories(
  config: Config,
  addItem: (
    itemData: Omit<HistoryItem, 'id'>,
    baseTimestamp?: number,
  ) => number,
  added: string[],
  errors: string[],
) {
  if (!config) {
    addItem({
      type: MessageType.ERROR,
      text: 'Configuration is not available.',
    });
    return;
  }

  try {
    if (config.shouldLoadMemoryFromIncludeDirectories()) {
      await config.getMemoryContextManager()?.refresh();
    }
  } catch (error) {
    errors.push(`Error refreshing memory: ${(error as Error).message}`);
  }

  if (added.length > 0) {
    // Added directories are read from workspace state on the next request.
  }

  if (errors.length > 0) {
    addItem({ type: MessageType.ERROR, text: errors.join('\n') });
  }
}

export function useIncludeDirsTrust(
  config: Config,
  isTrustedFolder: boolean | undefined,
  historyManager: UseHistoryManagerReturn,
  setCustomDialog: (dialog: React.ReactNode | null) => boolean | void,
  settings: LoadedSettings,
) {
  const { addItem } = historyManager;

  useEffect(() => {
    // Don't run this until the initial trust is determined.
    if (isTrustedFolder === undefined || !config) {
      return;
    }

    const pendingDirs = config.getPendingIncludeDirectories();
    if (pendingDirs.length === 0) {
      return;
    }

    // If folder trust is disabled, isTrustedFolder will be undefined.
    // In that case, or if the user decided not to trust the main folder,
    // we can just add the directories without checking them.
    if (config.getFolderTrust() === false || isTrustedFolder === false) {
      const added: string[] = [];
      const errors: string[] = [];
      const workspaceContext = config.getWorkspaceContext();

      const result = batchAddDirectories(workspaceContext, pendingDirs);
      added.push(...result.added);
      errors.push(...result.errors);

      if (added.length > 0 || errors.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        finishAddingDirectories(config, addItem, added, errors);
      }
      config.clearPendingIncludeDirectories();
      return;
    }

    // Collect additionalDirectories from all settings scopes. Directories
    // explicitly listed in any scope (including the project-level workspace
    // or local settings) are already trusted by the user and should not
    // trigger a trust dialog.
    const additionalDirs: string[] = [
      ...(settings.merged.permissions?.additionalDirectories ?? []),
      ...(settings.local.settings.permissions?.additionalDirectories ?? []),
    ];
    const undefinedTrustDirs: string[] = [];
    const trustedDirs: string[] = [];
    const added: string[] = [];
    const errors: string[] = [];

    for (const pathToAdd of pendingDirs) {
      const expandedPath = expandHomeDir(pathToAdd.trim());
      const isTrusted = isPathInAdditionalDirectories(
        expandedPath,
        additionalDirs,
      );
      if (isTrusted) {
        trustedDirs.push(pathToAdd.trim());
      } else {
        undefinedTrustDirs.push(pathToAdd.trim());
      }
    }

    const workspaceContext = config.getWorkspaceContext();
    if (trustedDirs.length > 0) {
      const result = batchAddDirectories(workspaceContext, trustedDirs);
      added.push(...result.added);
      errors.push(...result.errors);
    }

    if (undefinedTrustDirs.length > 0) {
      runLogger.log(
        'Creating custom dialog with undecidedDirs:',
        undefinedTrustDirs,
      );
      setCustomDialog(
        <MultiFolderTrustDialog
          folders={undefinedTrustDirs}
          onComplete={() => {
            setCustomDialog(null);
            config.clearPendingIncludeDirectories();
          }}
          trustedDirs={added}
          errors={errors}
          finishAddingDirectories={finishAddingDirectories}
          config={config}
          addItem={addItem}
        />,
      );
    } else if (added.length > 0 || errors.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-floating-promises
      finishAddingDirectories(config, addItem, added, errors);
      config.clearPendingIncludeDirectories();
    }
  }, [isTrustedFolder, config, addItem, setCustomDialog, settings]);
}
