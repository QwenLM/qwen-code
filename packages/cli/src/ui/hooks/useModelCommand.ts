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
  isVoiceModelMode: boolean;
  isVisionModelMode: boolean;
  isImageModelMode: boolean;
  modelDialogPersistScope: ModelDialogPersistScope | undefined;
  modelDialogPersistDefault: boolean;
  openModelDialog: (options?: {
    fastModelMode?: boolean;
    voiceModelMode?: boolean;
    visionModelMode?: boolean;
    imageModelMode?: boolean;
    persistScope?: ModelDialogPersistScope;
    persistDefault?: boolean;
  }) => void;
  closeModelDialog: () => void;
}

export const useModelCommand = (): UseModelCommandReturn => {
  const [isModelDialogOpen, setIsModelDialogOpen] = useState(false);
  const [isFastModelMode, setIsFastModelMode] = useState(false);
  const [isVoiceModelMode, setIsVoiceModelMode] = useState(false);
  const [isVisionModelMode, setIsVisionModelMode] = useState(false);
  const [isImageModelMode, setIsImageModelMode] = useState(false);
  const [modelDialogPersistScope, setModelDialogPersistScope] = useState<
    ModelDialogPersistScope | undefined
  >(undefined);
  const [modelDialogPersistDefault, setModelDialogPersistDefault] =
    useState(false);

  const openModelDialog = useCallback(
    (options?: {
      fastModelMode?: boolean;
      voiceModelMode?: boolean;
      visionModelMode?: boolean;
      imageModelMode?: boolean;
      persistScope?: ModelDialogPersistScope;
      persistDefault?: boolean;
    }) => {
      const voiceModelMode = options?.voiceModelMode ?? false;
      const visionModelMode = options?.visionModelMode ?? false;
      const imageModelMode = options?.imageModelMode ?? false;
      // Modes are mutually exclusive; a specialized mode suppresses fast mode.
      setIsFastModelMode(
        voiceModelMode || visionModelMode || imageModelMode
          ? false
          : (options?.fastModelMode ?? false),
      );
      setIsVoiceModelMode(
        visionModelMode || imageModelMode ? false : voiceModelMode,
      );
      setIsVisionModelMode(imageModelMode ? false : visionModelMode);
      setIsImageModelMode(imageModelMode);
      setModelDialogPersistScope(options?.persistScope);
      setModelDialogPersistDefault(options?.persistDefault ?? false);
      setIsModelDialogOpen(true);
    },
    [],
  );

  const closeModelDialog = useCallback(() => {
    setIsModelDialogOpen(false);
    setIsFastModelMode(false);
    setIsVoiceModelMode(false);
    setIsVisionModelMode(false);
    setIsImageModelMode(false);
    setModelDialogPersistScope(undefined);
    setModelDialogPersistDefault(false);
  }, []);

  return {
    isModelDialogOpen,
    isFastModelMode,
    isVoiceModelMode,
    isVisionModelMode,
    isImageModelMode,
    modelDialogPersistScope,
    modelDialogPersistDefault,
    openModelDialog,
    closeModelDialog,
  };
};
