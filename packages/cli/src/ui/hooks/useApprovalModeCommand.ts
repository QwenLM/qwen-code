/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
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
          // Do not persist a privileged mode that this workspace cannot use;
          // User scope would make it active in other trusted workspaces.
          if (
            !config.isTrustedFolder() &&
            mode !== ApprovalMode.DEFAULT &&
            mode !== ApprovalMode.PLAN
          ) {
            throw new Error(
              'Cannot enable privileged approval modes in an untrusted folder.',
            );
          }
          loadedSettings.setValue(scope, 'tools.approvalMode', mode);
          // A higher-precedence scope can shadow the value just written (the
          // dialog warns about this); keep the session on the effective mode.
          const effectiveMode =
            loadedSettings.merged.tools?.approvalMode ?? mode;
          config.setApprovalMode(effectiveMode);
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
