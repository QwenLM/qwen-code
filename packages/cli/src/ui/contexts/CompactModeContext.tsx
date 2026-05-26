/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backward-compat shim for the retired `compactMode` API.
 *
 * The TUI display optimization PR retired the global `compactMode` toggle
 * in favour of an inverse `verbose` preference plus a Ctrl+O transcript
 * overlay (see DisplayModeContext). External callers that still consume
 * `useCompactMode()` keep working: `compactMode === !verbose` (transcript
 * forces it false so all detail expands).
 *
 * Will be removed in a future minor.
 */
import type React from 'react';
import { useMemo } from 'react';
import { DisplayModeProvider, useDisplayMode } from './DisplayModeContext.js';

interface CompactModeContextType {
  compactMode: boolean;
  setCompactMode?: (value: boolean) => void;
}

export const useCompactMode = (): CompactModeContextType => {
  const { verbose, setVerbose, transcript } = useDisplayMode();
  return {
    compactMode: !(verbose || transcript),
    setCompactMode: setVerbose
      ? (value: boolean) => setVerbose(!value)
      : undefined,
  };
};

/**
 * Drop-in replacement for the old `<CompactModeProvider value={{ compactMode, setCompactMode }}>`.
 * Translates to the new DisplayModeProvider shape.
 */
export const CompactModeProvider: React.FC<{
  value: CompactModeContextType;
  children: React.ReactNode;
}> = ({ value, children }) => {
  const translated = useMemo(
    () => ({
      verbose: !value.compactMode,
      setVerbose: value.setCompactMode
        ? (v: boolean) => value.setCompactMode!(!v)
        : undefined,
      transcript: false,
    }),
    [value.compactMode, value.setCompactMode],
  );
  return (
    <DisplayModeProvider value={translated}>{children}</DisplayModeProvider>
  );
};
