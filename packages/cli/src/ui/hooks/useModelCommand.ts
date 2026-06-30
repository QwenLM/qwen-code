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
  isCompactionModelMode: boolean;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    voiceModelMode?: boolean;
    visionModelMode?: boolean;
    compactionModelMode?: boolean;
  }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);
  const [isVoiceModelMode, setIsVoiceModelMode] = useState(false);
  const [isVisionModelMode, setIsVisionModelMode] = useState(false);
  const [isCompactionModelMode, setIsCompactionModelMode] = useState(false);

  const openModelDialog = useCallback(
    (options?: {
      fastModelMode?: boolean;
      voiceModelMode?: boolean;
      visionModelMode?: boolean;
      compactionModelMode?: boolean;
    }) => {
      const voiceModelMode = options?.voiceModelMode ?? false;
      const visionModelMode = options?.visionModelMode ?? false;
      const compactionModelMode = options?.compactionModelMode ?? false;
      // Modes are mutually exclusive; a specialized mode suppresses fast mode.
      setIsFastModelMode(
        voiceModelMode || visionModelMode || compactionModelMode
          ? false
          : (options?.fastModelMode ?? false),
      );
      // Vision wins over voice when both are passed, so the dialog can't end up
      // in two specialized modes at once (mismatched title vs. highlighted row).
      setIsVoiceModelMode(
        visionModelMode || compactionModelMode ? false : voiceModelMode,
      );
      setIsVisionModelMode(compactionModelMode ? false : visionModelMode);
      setIsCompactionModelMode(compactionModelMode);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
    setIsVoiceModelMode(false);
    setIsVisionModelMode(false);
    setIsCompactionModelMode(false);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    isVoiceModelMode,
    isVisionModelMode,
    isCompactionModelMode,
    openModelDialog,
    closeModelDialog,
  };
};
