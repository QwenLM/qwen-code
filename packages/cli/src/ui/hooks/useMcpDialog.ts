/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export interface UseMcpDialogReturn {
  isMcpDialogOpen: boolean;
  openMcpDialog: () => void;
  closeMcpDialog: () => void;
}

export const useMcpDialog = (): UseMcpDialogReturn => {
  const [isMcpDialogOpen, setIsMcpDialogOpen] = useState(false);

  const openMcpDialog = useCallback(() => {
    setIsMcpDialogOpen(true);
  }, []);

  const closeMcpDialog = useCallback(() => {
    setIsMcpDialogOpen(false);
  }, []);

  return {
    isMcpDialogOpen,
    openMcpDialog,
    closeMcpDialog,
  };
};
