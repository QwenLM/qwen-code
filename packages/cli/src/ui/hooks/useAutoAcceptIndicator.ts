/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { type ApprovalMode, type Config } from '@qwen-code/qwen-code-core';
import { useEffect, useState } from 'react';
import type { HistoryItemWithoutId } from '../types.js';

export interface UseAutoAcceptIndicatorArgs {
  config: Config;
  addItem?: (item: HistoryItemWithoutId, timestamp: number) => void;
  onApprovalModeChange?: (mode: ApprovalMode) => void;
  shouldBlockTab?: () => boolean;
}

/**
 * Hook for displaying auto-accept indicator state.
 * Note: Mode cycling (Shift+Tab) is now handled by useWorkModeCycle hook.
 */
export function useAutoAcceptIndicator({
  config,
  onApprovalModeChange,
}: UseAutoAcceptIndicatorArgs): ApprovalMode {
  const currentConfigValue = config.getApprovalMode();
  const [showAutoAcceptIndicator, setShowAutoAcceptIndicator] =
    useState(currentConfigValue);

  useEffect(() => {
    setShowAutoAcceptIndicator(currentConfigValue);
  }, [currentConfigValue]);

  // Notify about approval mode changes
  useEffect(() => {
    onApprovalModeChange?.(currentConfigValue);
  }, [currentConfigValue, onApprovalModeChange]);

  return showAutoAcceptIndicator;
}
