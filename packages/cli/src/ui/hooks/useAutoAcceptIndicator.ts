/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ApprovalMode, type Config } from '@qwen-code/qwen-code-core';
import { useEffect, useState } from 'react';
import { useKeypress } from './useKeypress.js';
import type { HistoryItemWithoutId } from '../types.js';
import { MessageType } from '../types.js';

const APPROVAL_MODE_SEQUENCE: ApprovalMode[] = [
  ApprovalMode.PLAN,
  ApprovalMode.DEFAULT,
  ApprovalMode.AUTO_EDIT,
  ApprovalMode.YOLO,
];

export interface UseAutoAcceptIndicatorArgs {
  config: Config;
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void;
}

export function useAutoAcceptIndicator({
  config,
  addItem,
}: UseAutoAcceptIndicatorArgs): ApprovalMode {
  const currentConfigValue = config.getApprovalMode();
  const [showAutoAcceptIndicator, setShowAutoAcceptIndicator] =
    useState(currentConfigValue);

  useEffect(() => {
    setShowAutoAcceptIndicator(currentConfigValue);
  }, [currentConfigValue]);

  useKeypress(
    (key) => {
      if (!(key.shift && key.name === 'tab')) {
        return;
      }

      const currentMode = config.getApprovalMode();
      const currentIndex = APPROVAL_MODE_SEQUENCE.indexOf(currentMode);
      const nextIndex =
        currentIndex === -1
          ? 0
          : (currentIndex + 1) % APPROVAL_MODE_SEQUENCE.length;
      const nextApprovalMode = APPROVAL_MODE_SEQUENCE[nextIndex];

      try {
        config.setApprovalMode(nextApprovalMode);
        // Update local state immediately for responsiveness
        setShowAutoAcceptIndicator(nextApprovalMode);
      } catch (e) {
        addItem(
          {
            type: MessageType.INFO,
            text: (e as Error).message,
          },
          Date.now(),
        );
      }
    },
    { isActive: true },
  );

  return showAutoAcceptIndicator;
}
