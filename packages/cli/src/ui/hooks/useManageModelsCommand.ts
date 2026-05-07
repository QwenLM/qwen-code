/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';

interface UseManageModelsCommandReturn {
  isManageModelsDialogOpen: boolean;
  openManageModelsDialog: () => void;
  closeManageModelsDialog: () => void;
}

export function useManageModelsCommand(): UseManageModelsCommandReturn {
  const [isManageModelsDialogOpen, setIsManageModelsDialogOpen] =
    useState(false);

  const openManageModelsDialog = useCallback(() => {
    setIsManageModelsDialogOpen(true);
  }, []);

  const closeManageModelsDialog = useCallback(() => {
    setIsManageModelsDialogOpen(false);
  }, []);

  return {
    isManageModelsDialogOpen,
    openManageModelsDialog,
    closeManageModelsDialog,
  };
}
