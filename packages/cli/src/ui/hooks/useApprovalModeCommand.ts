/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { ApprovalMode, Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';
import { MessageType, type HistoryItemWithoutId } from '../types.js';

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
  addItem?: (item: HistoryItemWithoutId, baseTimestamp: number) => void,
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

        try {
          // Let the trust gate rule before anything reaches disk. Persisting
          // first would leave a refused privileged mode in settings.json (User
          // scope by default), where it silently applies in every workspace the
          // user has trusted — a later headless run there would start in YOLO.
          config.setApprovalMode(mode);
          loadedSettings.setValue(scope, 'tools.approvalMode', mode);
          // A higher-precedence scope can shadow the value just written (the
          // dialog warns about this); keep the session on the effective mode.
          // Re-applying is a no-op transition when nothing shadows it.
          const effectiveMode =
            loadedSettings.merged.tools?.approvalMode ?? mode;
          if (effectiveMode !== mode) {
            config.setApprovalMode(effectiveMode);
          }
        } catch (e) {
          // Say so instead of closing silently: the refusal is otherwise
          // invisible, because the dialog is dismissed either way.
          addItem?.(
            { type: MessageType.ERROR, text: (e as Error).message },
            Date.now(),
          );
        }
      } finally {
        setIsApprovalModeDialogOpen(false);
      }
    },
    [config, loadedSettings, addItem],
  );

  return {
    isApprovalModeDialogOpen,
    openApprovalModeDialog,
    handleApprovalModeSelect,
  };
};
