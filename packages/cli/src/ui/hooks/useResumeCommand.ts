/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export function useResumeCommand() {
  const [isResumeDialogOpen, setIsResumeDialogOpen] = useState(false);

  const openResumeDialog = useCallback(() => {
    setIsResumeDialogOpen(true);
  }, []);

  const closeResumeDialog = useCallback(() => {
    setIsResumeDialogOpen(false);
  }, []);

  return {
    isResumeDialogOpen,
    openResumeDialog,
    closeResumeDialog,
  };
}
