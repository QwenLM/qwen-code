/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';

type ModelDialogPersistScope = 'workspace' | 'user';

interface UseModelCommandReturn {
  isModelDialogOpen: boolean;
  isFastModelMode: boolean;
  isAdvisorModelMode: boolean;
  isVoiceModelMode: boolean;
  isVisionModelMode: boolean;
  isCompactionModelMode: boolean;
  isImageModelMode: boolean;
  modelDialogPersistScope: ModelDialogPersistScope | undefined;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    advisorModelMode?: boolean;
    voiceModelMode?: boolean;
    visionModelMode?: boolean;
    compactionModelMode?: boolean;
    imageModelMode?: boolean;
    persistScope?: ModelDialogPersistScope;
  }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);
  const [isAdvisorModelMode, setIsAdvisorModelMode] = useState(false);
  const [isVoiceModelMode, setIsVoiceModelMode] = useState(false);
  const [isVisionModelMode, setIsVisionModelMode] = useState(false);
  const [isCompactionModelMode, setIsCompactionModelMode] = useState(false);
  const [isImageModelMode, setIsImageModelMode] = useState(false);
  const [modelDialogPersistScope, setModelDialogPersistScope] = useState<
    ModelDialogPersistScope | undefined
  >(undefined);

  const openModelDialog = useCallback(
    (options?: {
      fastModelMode?: boolean;
      advisorModelMode?: boolean;
      voiceModelMode?: boolean;
      visionModelMode?: boolean;
      compactionModelMode?: boolean;
      imageModelMode?: boolean;
      persistScope?: ModelDialogPersistScope;
    }) => {
      const advisorModelMode = options?.advisorModelMode ?? false;
      const voiceModelMode = options?.voiceModelMode ?? false;
      const visionModelMode = options?.visionModelMode ?? false;
      const compactionModelMode = options?.compactionModelMode ?? false;
      const imageModelMode = options?.imageModelMode ?? false;
      // Modes are mutually exclusive; a specialized mode suppresses fast mode.
      setIsFastModelMode(
        voiceModelMode ||
          visionModelMode ||
          compactionModelMode ||
          imageModelMode ||
          advisorModelMode
          ? false
          : (options?.fastModelMode ?? false),
      );
      setIsAdvisorModelMode(
        voiceModelMode ||
          visionModelMode ||
          compactionModelMode ||
          imageModelMode
          ? false
          : advisorModelMode,
      );
      setIsVoiceModelMode(
        advisorModelMode ||
          visionModelMode ||
          compactionModelMode ||
          imageModelMode
          ? false
          : voiceModelMode,
      );
      setIsVisionModelMode(
        advisorModelMode || compactionModelMode || imageModelMode
          ? false
          : visionModelMode,
      );
      setIsCompactionModelMode(
        advisorModelMode || imageModelMode ? false : compactionModelMode,
      );
      setIsImageModelMode(imageModelMode);
      setModelDialogPersistScope(options?.persistScope);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
    setIsAdvisorModelMode(false);
    setIsVoiceModelMode(false);
    setIsVisionModelMode(false);
    setIsCompactionModelMode(false);
    setIsImageModelMode(false);
    setModelDialogPersistScope(undefined);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    isAdvisorModelMode,
    isVoiceModelMode,
    isVisionModelMode,
    isCompactionModelMode,
    isImageModelMode,
    modelDialogPersistScope,
    openModelDialog,
    closeModelDialog,
  };
};
