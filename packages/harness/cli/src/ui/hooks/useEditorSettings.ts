/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import type {
  LoadableSettingScope,
  LoadedSettings,
} from '../../config/settings.js';
import { MessageType } from '../types.js';
import type { EditorType } from '@qwen-code/core';
import {
  hasValidEditorCommand,
  getEditorDisplayName,
  coreEvents,
  CoreEvent,
} from '@qwen-code/core';
import type { UseHistoryManagerReturn } from './useHistoryManager.js';

const PREFERRED_EDITOR_SETTING_KEY = 'general.preferredEditor';

interface UseEditorSettingsReturn {
  isEditorDialogOpen: boolean;
  openEditorDialog: () => void;
  handleEditorSelect: (
    editorType: EditorType | undefined,
    scope: LoadableSettingScope,
  ) => void;
  exitEditorDialog: () => void;
}

export const useEditorSettings = (
  loadedSettings: LoadedSettings,
  setEditorError: (error: string | null) => void,
  addItem: UseHistoryManagerReturn['addItem'],
): UseEditorSettingsReturn => {
  const [isEditorDialogOpen, setIsEditorDialogOpen] = useState(false);

  const openEditorDialog = useCallback(() => {
    setIsEditorDialogOpen(true);
  }, []);

  const handleEditorSelect = useCallback(
    (editorType: EditorType | undefined, scope: LoadableSettingScope) => {
      if (editorType && !hasValidEditorCommand(editorType)) {
        return;
      }

      try {
        const saved = loadedSettings.setValue(
          scope,
          PREFERRED_EDITOR_SETTING_KEY,
          editorType,
        );
        if (!saved) return;
        addItem(
          {
            type: MessageType.INFO,
            text: `Editor preference ${editorType ? `set to "${getEditorDisplayName(editorType)}"` : 'cleared'} in ${scope} settings.`,
          },
          Date.now(),
        );
        setEditorError(null);
        setIsEditorDialogOpen(false);
        coreEvents.emit(CoreEvent.EditorSelected, { editor: editorType });
      } catch (error) {
        setEditorError(`Failed to set editor preference: ${error}`);
      }
    },
    [loadedSettings, setEditorError, addItem],
  );

  const exitEditorDialog = useCallback(() => {
    setIsEditorDialogOpen(false);
    coreEvents.emit(CoreEvent.EditorSelected, { editor: undefined });
  }, []);

  return {
    isEditorDialogOpen,
    openEditorDialog,
    handleEditorSelect,
    exitEditorDialog,
  };
};
