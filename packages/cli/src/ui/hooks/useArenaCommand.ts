/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useState } from 'react';

export type ArenaDialogType = 'start' | 'select' | 'stop' | 'status' | null;

interface UseArenaCommandReturn {
  activeArenaDialog: ArenaDialogType;
  openArenaDialog: (type: Exclude<ArenaDialogType, null>) => void;
  closeArenaDialog: () => void;
}

export function useArenaCommand(): UseArenaCommandReturn {
  const [activeArenaDialog, setActiveArenaDialog] =
    useState<ArenaDialogType>(null);

  const openArenaDialog = useCallback(
    (type: Exclude<ArenaDialogType, null>) => {
      setActiveArenaDialog(type);
    },
    [],
  );

  const closeArenaDialog = useCallback(() => {
    setActiveArenaDialog(null);
  }, []);

  return {
    activeArenaDialog,
    openArenaDialog,
    closeArenaDialog,
  };
}
