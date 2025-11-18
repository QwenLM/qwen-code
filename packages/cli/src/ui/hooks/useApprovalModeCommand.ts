/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';

interface UseApprovalModeCommandReturn {
  isApprovalModeDialogOpen: boolean;
  openApprovalModeDialog: () => void;
  handleApprovalModeSelect: (
    mode: ApprovalMode | undefined,
    scope: SettingScope,
  ) => void;
}

export const useApprovalModeCommand = (
  loadedSettings: LoadedSettings,
  config: Config,
): UseApprovalModeCommandReturn => {
  const [isApprovalModeDialogOpen, setIsApprovalModeDialogOpen] =
    useState(false);

  const openApprovalModeDialog = useCallback(() => {
    setIsApprovalModeDialogOpen(true);
  }, []);

  const handleApprovalModeSelect = useCallback(
    (mode: ApprovalMode | undefined, scope: SettingScope) => {
      try {
        if (!mode) {
          // User cancelled the dialog
          setIsApprovalModeDialogOpen(false);
          return;
        }

        // Set the mode in the current session and persist to settings
        loadedSettings.setValue(scope, 'tools.approvalMode', mode);
        config.setApprovalMode(
          loadedSettings.merged.tools?.approvalMode ?? mode,
        );
      } finally {
        setIsApprovalModeDialogOpen(false);
      }
    },
    [config, loadedSettings],
  );

  return {
    isApprovalModeDialogOpen,
    openApprovalModeDialog,
    handleApprovalModeSelect,
  };
};
