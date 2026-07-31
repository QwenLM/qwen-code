/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export interface UseStatsDialogReturn {
  isStatsDialogOpen: boolean;
  openStatsDialog: () => void;
  closeStatsDialog: () => void;
}

export const useStatsDialog = (): UseStatsDialogReturn => {
  const [isStatsDialogOpen, setIsStatsDialogOpen] = useState(false);
  const openStatsDialog = useCallback(() => setIsStatsDialogOpen(true), []);
  const closeStatsDialog = useCallback(() => setIsStatsDialogOpen(false), []);
  return { isStatsDialogOpen, openStatsDialog, closeStatsDialog };
};
