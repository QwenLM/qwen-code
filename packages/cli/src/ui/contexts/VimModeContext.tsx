/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';

export type VimMode = 'NORMAL' | 'INSERT';

// ── State context: only vimEnabled + vimMode ──
interface VimModeStateType {
  vimEnabled: boolean;
  vimMode: VimMode;
}

const VimModeStateContext = createContext<VimModeStateType | undefined>(
  undefined,
);

// ── Actions context: stable callbacks, never changes after mount ──
interface VimModeActionsType {
  toggleVimEnabled: () => Promise<boolean>;
  setVimMode: (mode: VimMode) => void;
}

const VimModeActionsContext = createContext<VimModeActionsType | undefined>(
  undefined,
);

// ── Provider ──

export const VimModeProvider = ({
  children,
  settings,
}: {
  children: React.ReactNode;
  settings: LoadedSettings;
}) => {
  const initialVimEnabled = settings.merged.general?.vimMode ?? false;
  const [vimEnabled, setVimEnabled] = useState(initialVimEnabled);
  const [vimMode, setVimMode] = useState<VimMode>(
    initialVimEnabled ? 'NORMAL' : 'INSERT',
  );

  useEffect(() => {
    const enabled = settings.merged.general?.vimMode ?? false;
    setVimEnabled(enabled);
    if (enabled) {
      setVimMode('NORMAL');
    }
  }, [settings.merged.general?.vimMode]);

  const toggleVimEnabled = useCallback(async () => {
    const newValue = !vimEnabled;
    setVimEnabled(newValue);
    if (newValue) {
      setVimMode('NORMAL');
    }
    await settings.setValue(SettingScope.User, 'general.vimMode', newValue);
    return newValue;
  }, [vimEnabled, settings]);

  const stateValue = useMemo(
    () => ({ vimEnabled, vimMode }),
    [vimEnabled, vimMode],
  );

  const actionsValue = useMemo(
    () => ({ toggleVimEnabled, setVimMode }),
    [toggleVimEnabled, setVimMode],
  );

  return (
    <VimModeActionsContext.Provider value={actionsValue}>
      <VimModeStateContext.Provider value={stateValue}>
        {children}
      </VimModeStateContext.Provider>
    </VimModeActionsContext.Provider>
  );
};

// ── Hooks ──

/** Subscribe to vim mode state (vimEnabled, vimMode). Re-renders on mode change. */
export const useVimModeState = () => {
  const context = useContext(VimModeStateContext);
  if (context === undefined) {
    throw new Error('useVimModeState must be used within a VimModeProvider');
  }
  return context;
};

/** Subscribe to vim mode actions (toggleVimEnabled, setVimMode). Stable — never triggers re-render. */
export const useVimModeActions = () => {
  const context = useContext(VimModeActionsContext);
  if (context === undefined) {
    throw new Error('useVimModeActions must be used within a VimModeProvider');
  }
  return context;
};

/** Combined hook for consumers that need both state and actions. Prefer the split hooks when possible. */
export const useVimMode = () => ({
  ...useVimModeState(),
  ...useVimModeActions(),
});
