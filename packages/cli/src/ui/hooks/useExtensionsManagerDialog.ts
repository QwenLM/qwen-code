/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseExtensionsManagerDialogReturn {
  isExtensionsManagerDialogOpen: boolean;
  openExtensionsManagerDialog: () => void;
  closeExtensionsManagerDialog: () => void;
}

export const useExtensionsManagerDialog =
  (): UseExtensionsManagerDialogReturn => {
    const [isExtensionsManagerDialogOpen, setIsExtensionsManagerDialogOpen] =
      useState(false);

    const openExtensionsManagerDialog = useCallback(() => {
      setIsExtensionsManagerDialogOpen(true);
    }, []);

    const closeExtensionsManagerDialog = useCallback(() => {
      setIsExtensionsManagerDialogOpen(false);
    }, []);

    return {
      isExtensionsManagerDialogOpen,
      openExtensionsManagerDialog,
      closeExtensionsManagerDialog,
    };
  };
