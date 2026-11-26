/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import type { FolderTrustChoice } from '../components/FolderTrustDialog.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { type HistoryItemWithoutId, MessageType } from '../types.js';
import {
  coreEvents,
  DEFAULT_CONTEXT_FILENAME,
  ExitCodes,
  isHeadlessMode,
  FolderTrustDiscoveryService,
  type FolderDiscoveryResults,
  type Config,
  BRAND_CLI_NAME,
  sessionLogger,
} from '@qwen-code/core';
import { gracefulExit } from '../../utils/cleanup.js';

export const useFolderTrust = (
  settings: LoadedSettings,
  config: Config,
  onTrustChange: (isTrusted: boolean | undefined) => void,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => number,
) => {
  const [isTrusted, setIsTrusted] = useState<boolean | undefined>(undefined);
  const [isFolderTrustDialogOpen, setIsFolderTrustDialogOpen] = useState(false);
  const [discoveryResults, setDiscoveryResults] =
    useState<FolderDiscoveryResults | null>(null);
  const startupMessageSent = useRef(false);

  const folderTrust = settings.merged.security.folderTrust.enabled ?? true;
  // Trust gates project resources, which remain rooted in the original project
  // when the session runs inside a worktree.
  const projectRoot = config.storage.getProjectRoot();

  useEffect(() => {
    let isMounted = true;
    const { isTrusted: trusted } = isWorkspaceTrusted(
      settings.merged,
      projectRoot,
    );

    if (trusted === undefined || trusted === false) {
      void FolderTrustDiscoveryService.discover(projectRoot)
        .then((results) => {
          if (isMounted) {
            setDiscoveryResults(results);
          }
        })
        .catch(() => {
          // Silently ignore discovery errors as they are handled within the service
          // and reported via results.discoveryErrors if successful.
        });
    }

    const showUntrustedMessage = () => {
      if (trusted === false && !startupMessageSent.current) {
        addItem(
          {
            type: MessageType.INFO,
            text: `This folder is untrusted, project settings, hooks, MCPs, and ${DEFAULT_CONTEXT_FILENAME} files will not be applied for this folder.\nUse the \`/permissions\` command to change the trust level.`,
          },
          Date.now(),
        );
        startupMessageSent.current = true;
      }
    };

    if (isHeadlessMode()) {
      if (isMounted) {
        setIsTrusted(trusted);
        setIsFolderTrustDialogOpen(false);
        onTrustChange(true);
        showUntrustedMessage();
      }
    } else if (isMounted) {
      setIsTrusted(trusted);
      setIsFolderTrustDialogOpen(trusted === undefined);
      onTrustChange(trusted);
      showUntrustedMessage();
    }

    return () => {
      isMounted = false;
    };
  }, [folderTrust, onTrustChange, settings.merged, addItem, projectRoot]);

  const handleFolderTrustSelect = useCallback(
    async (_choice: FolderTrustChoice) => {
      try {
        const saved = settings.updateValue(
          SettingScope.User,
          'permissions.trustDirectories',
          (current) => {
            const trustedDirs = Array.isArray(current)
              ? current.filter(
                  (entry): entry is string => typeof entry === 'string',
                )
              : [];
            return trustedDirs.includes(projectRoot)
              ? trustedDirs
              : [...trustedDirs, projectRoot];
          },
        );
        if (!saved) throw new Error('Settings write failed');
      } catch {
        coreEvents.emitFeedback(
          'error',
          `Failed to save trust settings. Exiting ${BRAND_CLI_NAME}.`,
        );
        setTimeout(async () => {
          sessionLogger.setExitContext({
            reason: 'config_error',
            exit_code: ExitCodes.FATAL_CONFIG_ERROR,
            message: 'Failed to save folder trust settings',
            source: 'ui.folderTrust',
          });
          await gracefulExit(ExitCodes.FATAL_CONFIG_ERROR, {
            exitReason: 'error',
          });
        }, 100);
        return;
      }

      const currentIsTrusted = true;

      // Reactively update trust state on Config and Settings without restart.
      // Config.isTrustedFolder() will now return the updated value, which
      // downstream callers (approval mode, skills, MCP, etc.) will pick up.
      settings.setTrusted(currentIsTrusted);
      config.setTrustedFolder(currentIsTrusted);

      onTrustChange(currentIsTrusted);
      setIsTrusted(currentIsTrusted);
      setIsFolderTrustDialogOpen(false);
    },
    [onTrustChange, config, settings, projectRoot],
  );

  return {
    isTrusted,
    isFolderTrustDialogOpen,
    discoveryResults,
    handleFolderTrustSelect,
  };
};
