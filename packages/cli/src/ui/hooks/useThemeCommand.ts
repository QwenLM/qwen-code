/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { themeManager, AUTO_THEME_NAME } from '../themes/theme-manager.js';
import type { LoadedSettings, SettingScope } from '../../config/settings.js'; // Import LoadedSettings, AppSettings, MergedSetting
import { type HistoryItemWithoutId, MessageType } from '../types.js';
import process from 'node:process';
import { t } from '../../i18n/index.js';
import { applyThemeSetting } from '../themes/theme-selection.js';
import type { Config } from '@qwen-code/qwen-code-core';

interface UseThemeCommandReturn {
  isThemeDialogOpen: boolean;
  openThemeDialog: () => void;
  handleThemeSelect: (
    themeName: string | undefined,
    scope: SettingScope,
  ) => void; // Added scope
  handleThemeHighlight: (themeName: string | undefined) => void;
}

export const useThemeCommand = (
  loadedSettings: LoadedSettings,
  setThemeError: (error: string | null) => void,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  initialThemeError: string | null,
  config?: Config,
): UseThemeCommandReturn => {
  const [isThemeDialogOpen, setIsThemeDialogOpen] =
    useState(!!initialThemeError);
  const [themeBeforeDialogOpen, setThemeBeforeDialogOpen] = useState<
    string | undefined
  >(themeManager.getActiveTheme().name);

  const openThemeDialog = useCallback(() => {
    if (process.env['NO_COLOR']) {
      const feedbackItem: HistoryItemWithoutId & Record<string, unknown> = {
        type: MessageType.INFO,
        text: t(
          'Theme configuration unavailable due to NO_COLOR env variable.',
        ),
      };
      addItem(feedbackItem, Date.now());
      config?.getChatRecordingService?.()?.recordSlashCommand({
        phase: 'result',
        rawCommand: '/theme',
        outputHistoryItems: [feedbackItem],
      });
      return;
    }
    // The theme may temporarily change while navigating the list; keep the
    // original value to restore it if user cancels with Esc/Ctrl+C.
    setThemeBeforeDialogOpen(themeManager.getActiveTheme().name);
    setThemeError(null);
    setIsThemeDialogOpen(true);
  }, [addItem, config, setThemeError]);

  const applyTheme = useCallback(
    (themeName: string | undefined) => {
      if (!themeManager.setActiveTheme(themeName)) {
        // If theme is not found, open the theme selection dialog and set error message
        setIsThemeDialogOpen(true);
        setThemeError(
          t('Theme "{{themeName}}" not found.', {
            themeName: themeName ?? '',
          }),
        );
      } else {
        setThemeError(null); // Clear any previous theme error on success
      }
    },
    [setThemeError],
  );

  const handleThemeHighlight = useCallback(
    (themeName: string | undefined) => {
      applyTheme(themeName);
    },
    [applyTheme],
  );

  const handleThemeSelect = useCallback(
    (themeName: string | undefined, scope: SettingScope) => {
      // Undefined means "cancel": close dialog and restore original theme.
      if (themeName === undefined) {
        applyTheme(themeBeforeDialogOpen);
        setThemeError(null);
        setIsThemeDialogOpen(false);
        return;
      }

      // Failed selections keep the dialog open so the error is shown.
      let keepOpen = false;
      try {
        // Merge user and workspace custom themes (workspace takes precedence)
        const mergedCustomThemes = {
          ...(loadedSettings.user.settings.ui?.customThemes || {}),
          ...(loadedSettings.workspace.settings.ui?.customThemes || {}),
        };
        // Only allow selecting themes available in the merged custom themes, built-in themes, or 'auto'
        const isAuto = themeName === AUTO_THEME_NAME;
        const isBuiltIn = themeManager.findThemeByName(themeName);
        const isCustom = themeName && mergedCustomThemes[themeName];
        if (!isAuto && !isBuiltIn && !isCustom) {
          setThemeError(
            t('Theme "{{themeName}}" not found in selected scope.', {
              themeName: themeName ?? '',
            }),
          );
          keepOpen = true;
          return;
        }
        const { effective, applied } = applyThemeSetting(
          loadedSettings,
          scope,
          themeName,
        );
        if (!applied) {
          setThemeError(
            t('Theme "{{themeName}}" not found.', { themeName: effective }),
          );
          keepOpen = true;
          return;
        }
        setThemeError(null);
      } finally {
        setIsThemeDialogOpen(keepOpen);
      }
    },
    [applyTheme, loadedSettings, setThemeError, themeBeforeDialogOpen],
  );

  return {
    isThemeDialogOpen,
    openThemeDialog,
    handleThemeSelect,
    handleThemeHighlight,
  };
};
