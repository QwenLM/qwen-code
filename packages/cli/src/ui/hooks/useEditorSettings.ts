/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type { LoadedSettings, SettingScope } from '../../config/settings.js';
import { type HistoryItemWithoutId, MessageType } from '../types.js';
import type { Config, EditorType } from '@qwen-code/qwen-code-core';
import {
  allowEditorTypeInSandbox,
  checkHasEditorType,
} from '@qwen-code/qwen-code-core';

interface UseEditorSettingsReturn {
  isEditorDialogOpen: boolean;
  openEditorDialog: () => void;
  handleEditorSelect: (
    editorType: EditorType | undefined,
    scope: SettingScope,
  ) => void;
  exitEditorDialog: () => void;
}

export const useEditorSettings = (
  loadedSettings: LoadedSettings,
  setEditorError: (error: string | null) => void,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  config?: Config,
): UseEditorSettingsReturn => {
  const [isEditorDialogOpen, setIsEditorDialogOpen] = useState(false);

  const openEditorDialog = useCallback(() => {
    setIsEditorDialogOpen(true);
  }, []);

  const handleEditorSelect = useCallback(
    (editorType: EditorType | undefined, scope: SettingScope) => {
      if (
        editorType &&
        (!checkHasEditorType(editorType) ||
          !allowEditorTypeInSandbox(editorType))
      ) {
        return;
      }

      try {
        loadedSettings.setValue(scope, 'general.preferredEditor', editorType);
        const feedbackItem: HistoryItemWithoutId & Record<string, unknown> = {
          type: MessageType.INFO,
          text: `Editor preference ${editorType ? `set to "${editorType}"` : 'cleared'} in ${scope} settings.`,
        };
        addItem(feedbackItem, Date.now());
        config?.getChatRecordingService?.()?.recordSlashCommand({
          phase: 'result',
          rawCommand: '/editor',
          outputHistoryItems: [feedbackItem],
        });
        setEditorError(null);
        setIsEditorDialogOpen(false);
      } catch (error) {
        setEditorError(`Failed to set editor preference: ${error}`);
      }
    },
    [loadedSettings, setEditorError, addItem, config],
  );

  const exitEditorDialog = useCallback(() => {
    setIsEditorDialogOpen(false);
  }, []);

  return {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  };
};
