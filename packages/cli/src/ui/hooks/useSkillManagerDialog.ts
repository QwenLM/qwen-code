/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export interface UseSkillManagerDialogReturn {
  isSkillManagerDialogOpen: boolean;
  openSkillManagerDialog: () => void;
  closeSkillManagerDialog: () => void;
}

export const useSkillManagerDialog = (): UseSkillManagerDialogReturn => {
  const [isSkillManagerDialogOpen, setIsSkillManagerDialogOpen] =
    useState(false);

  const openSkillManagerDialog = useCallback(() => {
    setIsSkillManagerDialogOpen(true);
  }, []);

  const closeSkillManagerDialog = useCallback(() => {
    setIsSkillManagerDialogOpen(false);
  }, []);

  return {
    isSkillManagerDialogOpen,
    openSkillManagerDialog,
    closeSkillManagerDialog,
  };
};
