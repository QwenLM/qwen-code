/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

interface UseModelCommandReturn {
  isModelDialogOpen: boolean;
  isFastModelMode: boolean;
  isVoiceModelMode: boolean;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    voiceModelMode?: boolean;
  }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);
  const [isVoiceModelMode, setIsVoiceModelMode] = useState(false);

  const openModelDialog = useCallback(
    (options?: { fastModelMode?: boolean; voiceModelMode?: boolean }) => {
      const voiceModelMode = options?.voiceModelMode ?? false;
      setIsFastModelMode(
        voiceModelMode ? false : (options?.fastModelMode ?? false),
      );
      setIsVoiceModelMode(voiceModelMode);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
    setIsVoiceModelMode(false);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    isVoiceModelMode,
    openModelDialog,
    closeModelDialog,
  };
};
