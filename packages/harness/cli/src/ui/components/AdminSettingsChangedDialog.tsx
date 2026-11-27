/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { useCallback, useMemo } from 'react';
import { theme } from '../semantic-colors.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import {
  useRegisterFallbackHandler,
  type ActionHandler,
} from '../contexts/ActionHandlerRegistry.js';
import { BaseTabDialog } from './shared/BaseTabDialog.js';
import { SHORTCUT_HINTS } from '../constants/shortcuts.js';

export const AdminSettingsChangedDialog = () => {
  const { handleRestart } = useUIActions();

  const restartHints = useMemo(
    () => [{ label: SHORTCUT_HINTS.R_RESTART, order: 10 }],
    [],
  );

  const fallbackHandler = useCallback<ActionHandler>(
    (key) => {
      if (key.sequence === 'r' || key.sequence === 'R') {
        handleRestart();
        return true;
      }
      return false;
    },
    [handleRestart],
  );

  useRegisterFallbackHandler('Dialog', fallbackHandler);

  return (
    <BaseTabDialog
      title="Admin Settings Changed"
      borderColor={theme.status.warning}
      extraHints={restartHints}
    >
      <Text color={theme.status.warning}>
        Admin settings have changed. Please restart the session to apply new
        settings.
      </Text>
    </BaseTabDialog>
  );
};
