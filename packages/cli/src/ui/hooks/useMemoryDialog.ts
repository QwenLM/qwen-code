/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export interface UseMemoryDialogReturn {
  isMemoryDialogOpen: boolean;
  openMemoryDialog: () => void;
  closeMemoryDialog: () => void;
}

export const useMemoryDialog = (): UseMemoryDialogReturn => {
  const [isMemoryDialogOpen, setIsMemoryDialogOpen] = useState(false);

  const openMemoryDialog = useCallback(() => {
    setIsMemoryDialogOpen(true);
  }, []);

  const closeMemoryDialog = useCallback(() => {
    setIsMemoryDialogOpen(false);
  }, []);

  return {
    isMemoryDialogOpen,
    openMemoryDialog,
    closeMemoryDialog,
  };
};
