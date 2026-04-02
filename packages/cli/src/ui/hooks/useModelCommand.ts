/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseModelCommandReturn {
  isModelDialogOpen: boolean;
  isFastModelMode: boolean;
  openModelDialog: (options?: { fastModelMode?: boolean }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);

  const openModelDialog = useCallback(
    (options?: { fastModelMode?: boolean }) => {
      setIsFastModelMode(options?.fastModelMode ?? false);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    openModelDialog,
    closeModelDialog,
  };
};
