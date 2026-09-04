/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';

// Defaults to false so history components render normally when mounted
// outside the provider (tests, standalone pickers).
const FocusModeStateContext = createContext<boolean>(false);

interface FocusModeActionsType {
  toggleFocusMode: () => Promise<boolean>;
}

// No-op default keeps consumers safe outside the provider (tests, opentui,
// non-interactive UI) — toggling there simply reports "still disabled".
const FocusModeActionsContext = createContext<FocusModeActionsType>({
  toggleFocusMode: async () => false,
});

export const FocusModeProvider = ({
  children,
  settings,
}: {
  children: React.ReactNode;
  settings: LoadedSettings;
}) => {
  const [focusModeEnabled, setFocusModeEnabled] = useState(
    settings.merged.ui?.focusMode ?? false,
  );

  useEffect(() => {
    setFocusModeEnabled(settings.merged.ui?.focusMode ?? false);
  }, [settings.merged.ui?.focusMode]);

  const focusModeEnabledRef = useRef(focusModeEnabled);
  focusModeEnabledRef.current = focusModeEnabled;

  const toggleFocusMode = useCallback(async () => {
    const newValue = !focusModeEnabledRef.current;
    setFocusModeEnabled(newValue);
    await settings.setValue(SettingScope.User, 'ui.focusMode', newValue);
    return newValue;
  }, [settings]);

  const actionsValue = useMemo(() => ({ toggleFocusMode }), [toggleFocusMode]);

  return (
    <FocusModeActionsContext.Provider value={actionsValue}>
      <FocusModeStateContext.Provider value={focusModeEnabled}>
        {children}
      </FocusModeStateContext.Provider>
    </FocusModeActionsContext.Provider>
  );
};

/** Whether focus mode is active. Safe outside the provider (returns false). */
export const useFocusModeEnabled = () => useContext(FocusModeStateContext);

/** Focus mode actions. Safe outside the provider (no-op toggle). */
export const useFocusModeActions = () => useContext(FocusModeActionsContext);
