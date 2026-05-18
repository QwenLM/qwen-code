/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ApprovalMode,
  APPROVAL_MODES,
  type Config,
} from '@qwen-code/qwen-code-core';
import { useEffect, useState } from 'react';
import { useKeypress } from './useKeypress.js';
import type { HistoryItemWithoutId } from '../types.js';
import { MessageType } from '../types.js';
import { type LoadedSettings, SettingScope } from '../../config/settings.js';

const AUTO_MODE_FIRST_TIME_MESSAGE =
  '✨ Auto mode enabled.\n' +
  '   An LLM classifier evaluates each tool call and auto-approves safe actions,\n' +
  '   blocks risky ones. Most read-only operations and in-cwd edits skip the\n' +
  '   classifier for speed. To exit: Shift+Tab or /approval-mode default.\n' +
  '   (This notice will not appear again.)';

export interface UseAutoAcceptIndicatorArgs {
  config: Config;
  /** Settings handle — used to read/write `ui.autoModeAcknowledged`. */
  settings?: LoadedSettings;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  shouldBlockTab?: () => boolean;
  /** When true, the keyboard handler is disabled (e.g. agent tab is active). */
  disabled?: boolean;
}

export function useAutoAcceptIndicator({
  config,
  settings,
  addItem,
  onApprovalModeChange,
  shouldBlockTab,
  disabled,
}: UseAutoAcceptIndicatorArgs): ApprovalMode {
  const currentConfigValue = config.getApprovalMode();
  const [showAutoAcceptIndicator, setShowAutoAcceptIndicator] =
    useState(currentConfigValue);

  useEffect(() => {
    setShowAutoAcceptIndicator(currentConfigValue);
  }, [currentConfigValue]);

  // Mount-time AUTO entry notice: when the session starts already in AUTO
  // (`--approval-mode auto` flag or `tools.approvalMode: "auto"` in
  // settings.json), the keypress / slash-command handlers below never fire,
  // so the first-time information message + stripped-rules notice are
  // missing on startup. Run them once on mount. The `acknowledged` flag in
  // emitAutoModeEntryNotices keeps repeated sessions silent.
  //
  // Read the initial mode from the already-captured `currentConfigValue`
  // closure rather than calling `config.getApprovalMode()` again so we
  // don't inflate the spy-count tests further down the file.
  useEffect(() => {
    if (currentConfigValue === ApprovalMode.AUTO) {
      emitAutoModeEntryNotices({ config, settings, addItem });
    }
    // Intentionally mount-only — subsequent mode changes are handled by
    // the Shift+Tab handler below and by the `/approval-mode` slash
    // command, which both call emitAutoModeEntryNotices on AUTO entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useKeypress(
    (key) => {
      // Handle Shift+Tab to cycle through all modes
      // On Windows, Shift+Tab is indistinguishable from Tab (\t) in some terminals,
      // so we allow Tab to switch modes as well to support the shortcut.
      const isShiftTab = key.shift && key.name === 'tab';
      const isWindowsTab =
        process.platform === 'win32' &&
        key.name === 'tab' &&
        !key.ctrl &&
        !key.meta;

      if (isShiftTab || isWindowsTab) {
        // On Windows, check if we should block Tab key when autocomplete is active
        if (isWindowsTab && shouldBlockTab?.()) {
          // Don't cycle approval mode when autocomplete is showing
          return;
        }

        const currentMode = config.getApprovalMode();
        const currentIndex = APPROVAL_MODES.indexOf(currentMode);
        const nextIndex =
          currentIndex === -1 ? 0 : (currentIndex + 1) % APPROVAL_MODES.length;
        const nextApprovalMode = APPROVAL_MODES[nextIndex];

        try {
          config.setApprovalMode(nextApprovalMode);
          // Update local state immediately for responsiveness
          setShowAutoAcceptIndicator(nextApprovalMode);

          // On AUTO entry: first-time info message + stripped-rules notice.
          if (
            nextApprovalMode === ApprovalMode.AUTO &&
            currentMode !== ApprovalMode.AUTO
          ) {
            emitAutoModeEntryNotices({ config, settings, addItem });
          }

          // Notify the central handler about the approval mode change
          onApprovalModeChange?.(nextApprovalMode);
        } catch (e) {
          addItem?.(
            {
              type: MessageType.INFO,
              text: (e as Error).message,
            },
            Date.now(),
          );
        }
      }
    },
    { isActive: !disabled },
  );

  return showAutoAcceptIndicator;
}

/**
 * Emit the first-time AUTO mode information message and (if any rules were
 * stripped) a notice listing them. Idempotent across calls thanks to the
 * `ui.autoModeAcknowledged` flag persisted to user settings.
 *
 * Exported so the `/approval-mode` slash command can fire the same notices
 * when the user switches into AUTO via the command (rather than Shift+Tab).
 */
export function emitAutoModeEntryNotices(opts: {
  config: Config;
  settings?: LoadedSettings;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
}): void {
  const { config, settings, addItem } = opts;
  if (!addItem) return;
  const now = Date.now();

  // First-time information message.
  const acknowledged = settings?.merged.ui?.autoModeAcknowledged === true;
  if (!acknowledged) {
    addItem(
      { type: MessageType.INFO, text: AUTO_MODE_FIRST_TIME_MESSAGE },
      now,
    );
    if (settings) {
      try {
        settings.setValue(SettingScope.User, 'ui.autoModeAcknowledged', true);
      } catch {
        // Persistence failure shouldn't break the UX; the user will just see
        // the notice again next session.
      }
    }
  }

  // Stripped-rules notice.
  const pm = config.getPermissionManager?.();
  const stripped = pm?.getStrippedDangerousRules?.();
  if (
    stripped &&
    (stripped.persistent.length > 0 || stripped.session.length > 0)
  ) {
    const lines = [
      'ℹ️ Auto mode temporarily disabled these allow rules',
      '   (they would bypass the classifier):',
      ...stripped.persistent.map((r) => `   - ${r.raw} (from user settings)`),
      ...stripped.session.map((r) => `   - ${r.raw} (session)`),
      '   These will be restored when leaving auto mode.',
    ];
    addItem({ type: MessageType.INFO, text: lines.join('\n') }, now + 1);
  }
}
