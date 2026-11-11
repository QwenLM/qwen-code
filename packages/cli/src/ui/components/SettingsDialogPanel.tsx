/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box } from 'ink';
import { gracefulExit } from '../../utils/cleanup.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useI18nService } from '../i18n/index.js';
import { SettingsDialog, type SettingChangeGuard } from './SettingsDialog.js';

interface SettingsDialogPanelProps {
  onClose: () => void;
  /** Product rules that block changing particular settings. */
  settingChangeGuard?: SettingChangeGuard;
}

/**
 * The settings dialog sized to the space below the transcript, exiting the CLI
 * when the user asks to restart after a restart-required change.
 */
export function SettingsDialogPanel({
  onClose,
  settingChangeGuard,
}: SettingsDialogPanelProps): React.JSX.Element {
  const i18n = useI18nService();
  const { terminalHeight, staticExtraHeight } = useUIState();
  const handleRestart = async () => {
    process.stderr.write(`\n${i18n.get('settings.restartApplyResult')}\n`);
    await gracefulExit(0, { exitReason: 'user_quit' });
  };
  return (
    <Box flexDirection="column">
      <SettingsDialog
        onSelect={() => onClose()}
        onRestartRequest={handleRestart}
        availableTerminalHeight={terminalHeight - staticExtraHeight}
        settingChangeGuard={settingChangeGuard}
      />
    </Box>
  );
}
