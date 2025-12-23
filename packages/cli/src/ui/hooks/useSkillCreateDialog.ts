/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

export function useSkillCreateDialog() {
  const [isSkillCreateDialogOpen, setIsSkillCreateDialogOpen] = useState(false);

  const openSkillCreateDialog = useCallback(() => {
    setIsSkillCreateDialogOpen(true);
  }, []);

  const closeSkillCreateDialog = useCallback(() => {
    setIsSkillCreateDialogOpen(false);
  }, []);

  return {
    isSkillCreateDialogOpen,
    openSkillCreateDialog,
    closeSkillCreateDialog,
  };
}
