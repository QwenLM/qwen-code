/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export interface UseHooksDialogReturn {
  isHooksDialogOpen: boolean;
  openHooksDialog: () => void;
  closeHooksDialog: () => void;
}

export const useHooksDialog = (): UseHooksDialogReturn => {
  const [isHooksDialogOpen, setIsHooksDialogOpen] = useState(false);

  const openHooksDialog = useCallback(() => {
    setIsHooksDialogOpen(true);
  }, []);

  const closeHooksDialog = useCallback(() => {
    setIsHooksDialogOpen(false);
  }, []);

  return {
    isHooksDialogOpen,
    openHooksDialog,
    closeHooksDialog,
  };
};
