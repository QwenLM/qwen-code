/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
} from 'react';
import { useSettingsStore, type SettingsState } from './SettingsContext.js';

export type VimMode = 'NORMAL' | 'INSERT';

interface VimModeContextType {
  vimEnabled: boolean;
  vimMode: VimMode;
  toggleVimEnabled: () => Promise<boolean>;
  setVimMode: (mode: VimMode) => void;
}

const VimModeContext = createContext<VimModeContextType | undefined>(undefined);

function vimModeSignature(settings: SettingsState): string {
  return [
    settings.user.settings.general?.vimMode,
    settings.project.settings.general?.vimMode,
    settings.local.settings.general?.vimMode,
    settings.flag.settings.general?.vimMode,
  ].join('|');
}

export const VimModeProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { settings } = useSettingsStore();
  const persistedVim = settings.merged.general.vimMode;
  const persistedSig = vimModeSignature(settings);
  const [sessionOverride, setSessionOverride] = useState<boolean | null>(null);
  const lastPersistedSig = useRef(persistedSig);
  const [vimMode, setVimMode] = useState<VimMode>('INSERT');

  let effectiveOverride = sessionOverride;
  if (lastPersistedSig.current !== persistedSig) {
    lastPersistedSig.current = persistedSig;
    effectiveOverride = null;
    if (sessionOverride !== null) {
      setSessionOverride(null);
    }
  }

  const vimEnabled = effectiveOverride ?? persistedVim;

  const toggleVimEnabled = useCallback(async () => {
    const newValue = !vimEnabled;
    if (newValue) {
      setVimMode('INSERT');
    }
    setSessionOverride(newValue);
    return newValue;
  }, [vimEnabled]);

  const value = {
    vimEnabled,
    vimMode,
    toggleVimEnabled,
    setVimMode,
  };

  return (
    <VimModeContext.Provider value={value}>{children}</VimModeContext.Provider>
  );
};

export const useVimMode = () => {
  const context = useContext(VimModeContext);
  if (context === undefined) {
    throw new Error('useVimMode must be used within a VimModeProvider');
  }
  return context;
};
