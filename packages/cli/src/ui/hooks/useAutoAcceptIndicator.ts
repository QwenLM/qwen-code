/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ApprovalMode,
  APPROVAL_MODES,
  type Config,
} from '@qwen-code/qwen-code-core';
import { useEffect, useState } from 'react';
import { useKeypress } from './useKeypress.js';
import type { HistoryItemWithoutId } from '../types.js';
import { MessageType } from '../types.js';

export interface UseAutoAcceptIndicatorArgs {
  config: Config;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  shouldBlockTab?: () => boolean;
}

export function useAutoAcceptIndicator({
  config,
  addItem,
  onApprovalModeChange,
  shouldBlockTab,
}: UseAutoAcceptIndicatorArgs): ApprovalMode {
  const currentConfigValue = config.getApprovalMode();
  const [showAutoAcceptIndicator, setShowAutoAcceptIndicator] =
    useState(currentConfigValue);

  useEffect(() => {
    setShowAutoAcceptIndicator(currentConfigValue);
  }, [currentConfigValue]);

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
    { isActive: true },
  );

  return showAutoAcceptIndicator;
}
