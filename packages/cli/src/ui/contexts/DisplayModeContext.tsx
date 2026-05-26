/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createContext, useContext } from 'react';

/**
 * Global display-mode preference.
 *
 *   - `verbose`     User preference (settings / `--verbose` / `/verbose`).
 *                   When false (default), thoughts are hidden in the main
 *                   stream and tool groups are merged.
 *   - `transcript`  Only true while the Ctrl+O transcript overlay is
 *                   rendering. Forces effective verbose=true for the
 *                   overlay regardless of the user preference, so that
 *                   the frozen snapshot always shows full detail.
 */
export interface DisplayModeContextType {
  verbose: boolean;
  setVerbose?: (value: boolean) => void;
  transcript: boolean;
}

const DisplayModeContext = createContext<DisplayModeContextType>({
  verbose: false,
  transcript: false,
});

export const useDisplayMode = (): DisplayModeContextType =>
  useContext(DisplayModeContext);

/**
 * Convenience: returns `verbose || transcript`. Most components only need
 * this single boolean to decide whether to expand thoughts / drop merging.
 */
export const useEffectiveVerbose = (): boolean => {
  const { verbose, transcript } = useDisplayMode();
  return verbose || transcript;
};

export const DisplayModeProvider = DisplayModeContext.Provider;
