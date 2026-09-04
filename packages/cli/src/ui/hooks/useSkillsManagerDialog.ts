/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export interface UseSkillsManagerDialogReturn {
  isSkillsManagerDialogOpen: boolean;
  openSkillsManagerDialog: () => void;
  closeSkillsManagerDialog: () => void;
}

export const useSkillsManagerDialog = (): UseSkillsManagerDialogReturn => {
  const [isSkillsManagerDialogOpen, setIsSkillsManagerDialogOpen] =
    useState(false);

  const openSkillsManagerDialog = useCallback(() => {
    setIsSkillsManagerDialogOpen(true);
  }, []);

  const closeSkillsManagerDialog = useCallback(() => {
    setIsSkillsManagerDialogOpen(false);
  }, []);

  return {
    isSkillsManagerDialogOpen,
    openSkillsManagerDialog,
    closeSkillsManagerDialog,
  };
};
