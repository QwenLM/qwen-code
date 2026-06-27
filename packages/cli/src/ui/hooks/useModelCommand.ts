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
  isVisionModelMode: boolean;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    voiceModelMode?: boolean;
    visionModelMode?: boolean;
  }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);
  const [isVoiceModelMode, setIsVoiceModelMode] = useState(false);
  const [isVisionModelMode, setIsVisionModelMode] = useState(false);

  const openModelDialog = useCallback(
    (options?: {
      fastModelMode?: boolean;
      voiceModelMode?: boolean;
      visionModelMode?: boolean;
    }) => {
      const voiceModelMode = options?.voiceModelMode ?? false;
      const visionModelMode = options?.visionModelMode ?? false;
      // Modes are mutually exclusive; a specialized mode suppresses fast mode.
      setIsFastModelMode(
        voiceModelMode || visionModelMode
          ? false
          : (options?.fastModelMode ?? false),
      );
      // Vision wins over voice when both are passed, so the dialog can't end up
      // in two specialized modes at once (mismatched title vs. highlighted row).
      setIsVoiceModelMode(visionModelMode ? false : voiceModelMode);
      setIsVisionModelMode(visionModelMode);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
    setIsVoiceModelMode(false);
    setIsVisionModelMode(false);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    isVoiceModelMode,
    isVisionModelMode,
    openModelDialog,
    closeModelDialog,
  };
};
